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
