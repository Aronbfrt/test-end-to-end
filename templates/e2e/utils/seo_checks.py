"""Checks SEO — chaque message d'assertion dit ce qui ne va pas ET pourquoi ça compte, pour
que le rapport HTML s'explique seul sans ouvrir les devtools. Tag les tests @pytest.mark.seo.
"""
from selenium.webdriver.common.by import By


def check_title_tag(driver, min_len: int = 10, max_len: int = 65) -> None:
    title = driver.title.strip()
    assert title, '[SEO] <title> manquant — chaque page indexée a besoin d\'un titre unique, sinon elle apparaît "sans titre" dans les résultats de recherche'
    assert min_len <= len(title) <= max_len, \
        f'[SEO] <title> de {len(title)} caractères (« {title} ») hors plage {min_len}-{max_len} — Google tronque les titres au-delà de ~60 caractères dans les résultats'


def check_meta_description(driver, min_len: int = 70, max_len: int = 160) -> None:
    els = driver.find_elements(By.CSS_SELECTOR, 'meta[name=description]')
    assert els, '[SEO] <meta name="description"> manquante — Google affiche un extrait aléatoire de la page au lieu de ton texte d\'accroche'
    content = els[0].get_attribute('content') or ''
    assert min_len <= len(content) <= max_len, \
        f'[SEO] meta description de {len(content)} caractères hors plage {min_len}-{max_len} — trop courte gaspille la place dans les résultats, trop longue se fait tronquer'


def check_canonical_tag(driver) -> None:
    els = driver.find_elements(By.CSS_SELECTOR, 'link[rel=canonical]')
    assert els, '[SEO] <link rel="canonical"> manquante — risque de pénalité contenu dupliqué si la même page est accessible via plusieurs URLs'


def check_single_h1(driver) -> None:
    h1s = driver.find_elements(By.TAG_NAME, 'h1')
    assert len(h1s) >= 1, '[SEO] aucun <h1> trouvé — les moteurs de recherche s\'en servent comme signal principal du sujet de la page'
    assert len(h1s) == 1, f'[SEO] {len(h1s)} balises <h1> trouvées — plusieurs H1 dilue le signal de sujet, garder exactement une seule'


def check_images_have_alt(driver, max_missing_ratio: float = 0.1) -> None:
    imgs = driver.find_elements(By.TAG_NAME, 'img')
    if not imgs:
        return
    missing = [i for i in imgs if not (i.get_attribute('alt') or '').strip()]
    ratio = len(missing) / len(imgs)
    assert ratio <= max_missing_ratio, \
        f'[SEO] {len(missing)}/{len(imgs)} images sans texte alternatif — pénalise le référencement image et l\'accessibilité lecteur d\'écran'


def check_structured_data_present(driver) -> None:
    els = driver.find_elements(By.CSS_SELECTOR, 'script[type="application/ld+json"]')
    assert els, '[SEO] aucune donnée structurée JSON-LD — pas d\'éligibilité aux résultats enrichis (prix/étoiles dans les résultats de recherche)'


def check_status_200(driver) -> None:
    """Heuristique car Selenium n'a pas d'accès direct au code HTTP — recherche les marqueurs d'erreur classiques."""
    src = driver.page_source.lower()
    error_markers = ['404 not found', '500 internal server error', 'whitelabel error page']
    hit = [m for m in error_markers if m in src]
    assert not hit, f'[SEO] la page renvoie un état d\'erreur ({hit[0]}) — une page d\'erreur ne doit jamais être indexable, vérifier le vrai code HTTP'


def check_robots_txt_reachable(driver, base_url: str) -> None:
    driver.get(base_url + '/robots.txt')
    src = driver.page_source.lower()
    assert '404' not in driver.title.lower(), '[SEO] /robots.txt inaccessible — les robots ne peuvent pas lire les directives de crawl ni l\'emplacement du sitemap'


def check_sitemap_reachable(driver, base_url: str) -> None:
    driver.get(base_url + '/sitemap.xml')
    assert '<urlset' in driver.page_source or '<sitemapindex' in driver.page_source, \
        '[SEO] /sitemap.xml manquant ou mal formé — les moteurs de recherche découvrent les pages plus lentement sans lui'


def check_html_lang_attribute(driver) -> None:
    lang = driver.execute_script("return document.documentElement.lang") or ''
    assert lang.strip(), \
        '[SEO] <html lang="..."> manquant — sans lui, Google et les lecteurs d\'écran doivent deviner la langue de la page, ce qui dégrade le ciblage géographique/linguistique et l\'accessibilité'


def check_viewport_meta(driver) -> None:
    els = driver.find_elements(By.CSS_SELECTOR, 'meta[name=viewport]')
    assert els, \
        '[SEO] <meta name="viewport"> manquante — Google utilise l\'indexation mobile-first, une page sans viewport est traitée comme non adaptée au mobile et perd du classement'
    content = (els[0].get_attribute('content') or '').lower()
    assert 'width=device-width' in content, \
        f'[SEO] meta viewport présente mais sans "width=device-width" (contenu actuel: "{content}") — la page ne s\'adapte pas correctement à l\'écran mobile'


def check_open_graph_tags(driver) -> None:
    """og:title/description/image — sans eux, un partage sur Facebook/LinkedIn/Discord
    affiche une carte vide ou un extrait aléatoire au lieu d'un visuel maîtrisé."""
    required = ['og:title', 'og:description', 'og:image']
    missing = [tag for tag in required if not driver.find_elements(By.CSS_SELECTOR, f'meta[property="{tag}"]')]
    assert not missing, \
        f'[SEO] balises Open Graph manquantes: {missing} — un partage sur les réseaux sociaux affichera une carte vide ou un extrait aléatoire au lieu du visuel/texte choisi'


def check_canonical_is_https(driver) -> None:
    els = driver.find_elements(By.CSS_SELECTOR, 'link[rel=canonical]')
    if not els:
        return  # absence déjà couverte par check_canonical_tag — ne pas dupliquer l'échec
    href = els[0].get_attribute('href') or ''
    assert href.startswith('https://'), \
        f'[SEO] canonical pointe vers une URL non-https ("{href}") — Google préfère et indexe la version https, une canonical http crée un signal contradictoire'


def check_heading_hierarchy(driver) -> None:
    """Pas de niveau de titre sauté (h1 -> h3 sans h2) — perturbe la structure sémantique
    que les moteurs de recherche et les lecteurs d'écran utilisent pour comprendre le plan."""
    levels = driver.execute_script("""
        return Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6'))
            .map(h => parseInt(h.tagName[1], 10));
    """)
    skips = []
    for prev, curr in zip(levels, levels[1:]):
        if curr - prev > 1:
            skips.append(f'h{prev}->h{curr}')
    assert not skips, \
        f'[SEO] hiérarchie de titres avec des niveaux sautés: {skips} — un h1 suivi directement d\'un h3 (sans h2) casse le plan sémantique de la page'


def check_no_noindex(driver) -> None:
    """Garde-fou — une page censée être indexable ne doit jamais porter un noindex oublié
    (configuration de staging copiée en prod, balise ajoutée par erreur...)."""
    els = driver.find_elements(By.CSS_SELECTOR, 'meta[name=robots], meta[name=googlebot]')
    flagged = [el.get_attribute('content') or '' for el in els if 'noindex' in (el.get_attribute('content') or '').lower()]
    assert not flagged, \
        f'[SEO] balise meta robots contient "noindex" ({flagged}) — cette page sera retirée des résultats de recherche. Si c\'est volontaire, ignore ce test pour cette page ; sinon c\'est probablement une config de staging restée en prod'
