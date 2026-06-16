"""Reusable quality-gate assertions — call from any domain test file.
Keeps a11y/perf/responsive logic in one place instead of duplicated per page.
"""
from selenium.webdriver.common.by import By

BLOCKING_IMPACTS = {'critical', 'serious'}
LOAD_TIME_BUDGET_MS = 4000
MAX_IMAGE_BYTES = 500_000  # 500KB


def check_accessibility(driver, blocking_impacts: set | None = None) -> None:
    """Scan axe-core sur la page courante. Échoue seulement sur violations critical/serious."""
    from axe_selenium_python import Axe
    axe = Axe(driver)
    axe.inject()
    results = axe.run()
    blocking = [v for v in results['violations'] if v['impact'] in (blocking_impacts or BLOCKING_IMPACTS)]
    assert not blocking, '; '.join(f"{v['id']}: {v['help']}" for v in blocking)


def check_no_horizontal_overflow(driver, label: str = '') -> None:
    scroll_width = driver.execute_script('return document.documentElement.scrollWidth')
    client_width = driver.execute_script('return document.documentElement.clientWidth')
    assert scroll_width <= client_width + 1, \
        f'{label} : débordement horizontal ({scroll_width}px de contenu dans un viewport de {client_width}px)'


def check_load_budget(driver, budget_ms: int = LOAD_TIME_BUDGET_MS) -> None:
    load_ms = driver.execute_script("const t = performance.timing; return t.loadEventEnd - t.navigationStart;")
    assert load_ms < budget_ms, f'temps de chargement {load_ms}ms dépasse le budget de {budget_ms}ms'


def check_no_console_errors(driver, allow: list[str] | None = None) -> None:
    allow = allow or []
    try:
        logs = driver.get_log('browser')
    except Exception:
        return  # navigateur sans API de logs console (Firefox/geckodriver) — rien à vérifier
    errors = [e for e in logs if e.get('level') == 'SEVERE']
    errors = [e for e in errors if not any(a in e.get('message', '') for a in allow)]
    assert not errors, f'erreurs console : {errors}'


def check_no_oversized_images(driver, max_bytes: int = MAX_IMAGE_BYTES) -> None:
    entries = driver.execute_script("""
        return performance.getEntriesByType('resource')
            .filter(e => e.initiatorType === 'img')
            .map(e => ({name: e.name, size: e.transferSize}));
    """)
    offenders = [e for e in entries if e['size'] > max_bytes]
    assert not offenders, 'images surdimensionnées (>{}Ko) : {}'.format(
        max_bytes // 1024, ', '.join(f"{o['name']} ({o['size'] // 1024}Ko)" for o in offenders)
    )


def check_csrf_token(driver) -> None:
    els = driver.find_elements(By.CSS_SELECTOR, 'input[name=csrf_token], input[name=_token]')
    assert els, 'token CSRF absent du formulaire'


def check_required_fields(driver, fields: list[str]) -> None:
    for field in fields:
        assert driver.find_element(By.NAME, field), f'champ requis "{field}" introuvable'


# ── Accessibility — au-delà du scan axe-core générique, des points précis que les
# utilisateurs clavier/lecteur d'écran rencontrent concrètement.

def check_skip_link(driver) -> None:
    """Un lien 'aller au contenu' en tout début de page permet aux utilisateurs clavier de
    sauter la nav répétitive — sans lui, chaque page nécessite de re-tabuler toute la nav."""
    els = driver.find_elements(By.CSS_SELECTOR, 'a[href^="#"]')
    has_skip = any(
        any(kw in (el.text or '').lower() for kw in ('contenu', 'skip', 'passer'))
        or any(kw in (el.get_attribute('class') or '').lower() for kw in ('skip',))
        for el in els[:5]  # seulement les premiers liens — un skip-link est censé être en tout début de DOM
    )
    assert has_skip, \
        "[A11Y] aucun lien 'aller au contenu' détecté en début de page — un utilisateur clavier doit re-tabuler toute la navigation à chaque page. Fix : <a href=\"#main\" class=\"skip-link\">Aller au contenu</a> en tout premier élément focusable."


def check_form_labels(driver) -> None:
    """Chaque champ visible doit avoir un label associé (for/id, aria-label ou
    aria-labelledby) — sans ça un lecteur d'écran annonce juste 'champ de texte', sans dire lequel."""
    unlabeled = driver.execute_script("""
        const fields = Array.from(document.querySelectorAll('input, select, textarea'))
            .filter(f => f.offsetParent !== null && f.type !== 'hidden' && f.type !== 'submit' && f.type !== 'button');
        return fields.filter(f => {
            const hasAria = f.getAttribute('aria-label') || f.getAttribute('aria-labelledby');
            const hasLabelFor = f.id && document.querySelector(`label[for="${f.id}"]`);
            const hasWrappingLabel = f.closest('label');
            return !hasAria && !hasLabelFor && !hasWrappingLabel;
        }).map(f => f.name || f.id || f.outerHTML.slice(0, 60));
    """)
    assert not unlabeled, \
        f'[A11Y] champ(s) de formulaire sans label associé : {unlabeled} — un lecteur d\'écran ne peut pas dire à quoi sert le champ. Fix : <label for="id">, aria-label, ou englober le champ dans <label>.'


def check_aria_landmarks(driver) -> None:
    """Les zones sémantiques (header/nav/main/footer ou rôles ARIA équivalents) permettent
    à un utilisateur de lecteur d'écran de naviguer par région au lieu de tout lire linéairement."""
    landmarks = driver.execute_script("""
        return {
            main: document.querySelectorAll('main, [role="main"]').length,
            nav: document.querySelectorAll('nav, [role="navigation"]').length,
        };
    """)
    assert landmarks['main'] >= 1, \
        '[A11Y] aucune zone <main> (ou role="main") — un lecteur d\'écran ne peut pas sauter directement au contenu principal'
    assert landmarks['nav'] >= 1, \
        '[A11Y] aucune zone <nav> (ou role="navigation") — la navigation n\'est pas identifiable comme telle pour un lecteur d\'écran'


def check_no_aria_hidden_focusable(driver) -> None:
    """Un élément aria-hidden="true" qui contient encore un lien/bouton focusable est un bug
    courant : le lecteur d'écran ignore l'élément (bien) mais Tab y entre quand même (mauvais) —
    l'utilisateur clavier atterrit sur un élément que le lecteur d'écran n'annonce jamais."""
    offenders = driver.execute_script("""
        return Array.from(document.querySelectorAll('[aria-hidden="true"]'))
            .filter(el => el.querySelector('a[href], button, input, select, textarea, [tabindex]'))
            .map(el => el.outerHTML.slice(0, 80));
    """)
    assert not offenders, \
        f'[A11Y] élément(s) aria-hidden="true" contenant un enfant focusable : {offenders} — le lecteur d\'écran ignore l\'élément mais Tab y entre quand même, désorientant l\'utilisateur clavier'


def check_button_accessible_name(driver) -> None:
    """Un bouton icône-only (juste un <svg>/<i>, aucun texte) sans aria-label est annoncé
    comme 'bouton' sans contexte par un lecteur d'écran — inutilisable."""
    unnamed = driver.execute_script("""
        return Array.from(document.querySelectorAll('button, [role="button"]'))
            .filter(b => b.offsetParent !== null)
            .filter(b => !b.textContent.trim() && !b.getAttribute('aria-label') && !b.getAttribute('aria-labelledby') && !b.getAttribute('title'))
            .map(b => b.outerHTML.slice(0, 60));
    """)
    assert not unnamed, \
        f'[A11Y] bouton(s) sans nom accessible : {unnamed} — annoncé comme juste "bouton" par un lecteur d\'écran, sans dire à quoi il sert. Fix : aria-label="..." sur les boutons icône-only.'


# ── Responsive — au-delà du débordement horizontal et de la taille des cibles tactiles.

def check_responsive_images(driver, max_offenders_ratio: float = 0.1) -> None:
    """Une image avec une largeur fixe en px plus large que le viewport force soit un
    débordement horizontal, soit un téléchargement inutilement lourd sur mobile.

    Ne considère que les images qui ont réellement chargé (naturalWidth > 0) — sur une
    image cassée (404, etc.), Chrome rend une icône d'erreur à taille fixe (~16px) et
    ignore le CSS width/max-width pour le calcul de getComputedStyle ; vérifier le
    dimensionnement responsive sur une image qui n'a même pas chargé n'a pas de sens
    (et donnerait un résultat trompeur sans rapport avec le vrai problème, qui serait
    plutôt "cette image est cassée", pas "elle n'est pas responsive")."""
    offenders, total = driver.execute_script("""
        const vw = document.documentElement.clientWidth;
        const loaded = Array.from(document.querySelectorAll('img')).filter(img => img.complete && img.naturalWidth > 0);
        const bad = loaded.filter(img => {
            const style = getComputedStyle(img);
            const fixedWidth = parseFloat(style.width);
            return style.maxWidth === 'none' && fixedWidth > vw;
        });
        return [bad.length, loaded.length];
    """)
    if total == 0:
        return
    assert offenders / total <= max_offenders_ratio, \
        f'[RESPONSIVE] {offenders}/{total} images en largeur fixe plus large que le viewport, sans max-width — force un débordement horizontal ou un téléchargement trop lourd sur mobile. Fix : max-width: 100%; height: auto;'


def check_mobile_font_size_readable(driver, min_px: float = 12.0) -> None:
    """Un texte de corps sous ~12px sur mobile force l'utilisateur à zoomer pour lire —
    Google le compte aussi comme signal négatif pour l'indexation mobile-first."""
    size = driver.execute_script("return parseFloat(getComputedStyle(document.body).fontSize)")
    assert size >= min_px, \
        f'[RESPONSIVE] taille de police du <body> à {size}px, sous le seuil de lisibilité mobile de {min_px}px — force un zoom pour lire confortablement'


# ── Performance — au-delà du budget de chargement et des images surdimensionnées.

def check_no_render_blocking_js(driver, max_blocking: int = 2) -> None:
    """Un <script> classique (pas async/defer/module) placé dans <head> bloque le rendu de
    toute la page jusqu'à ce qu'il soit téléchargé ET exécuté — chaque script de plus ajoute
    un aller-retour réseau avant que l'utilisateur ne voie quoi que ce soit."""
    blocking = driver.execute_script("""
        return Array.from(document.querySelectorAll('head script[src]'))
            .filter(s => !s.async && !s.defer && s.type !== 'module').length;
    """)
    assert blocking <= max_blocking, \
        f'[PERFORMANCE] {blocking} script(s) bloquant le rendu dans <head> (ni async ni defer) — chacun retarde le premier affichage. Fix : ajouter async ou defer, ou déplacer en fin de <body>.'


def check_total_page_weight(driver, max_bytes: int = 3_000_000) -> None:
    """Le poids total transféré (tous les sous-ressources) — gros budget mais utile pour
    attraper une régression flagrante (un asset de plusieurs Mo ajouté par erreur)."""
    total = driver.execute_script("""
        return performance.getEntriesByType('resource')
            .reduce((sum, e) => sum + (e.transferSize || 0), 0);
    """)
    assert total <= max_bytes, \
        f'[PERFORMANCE] poids total de la page {total // 1024}Ko dépasse le budget de {max_bytes // 1024}Ko — chaque visiteur télécharge tout ça à chaque visite (hors cache)'


def check_dom_size_budget(driver, max_nodes: int = 1500) -> None:
    """Un DOM trop large (Lighthouse alerte au-delà de ~1500 nœuds) ralentit le style/layout
    et la mémoire, surtout sur mobile bas de gamme."""
    count = driver.execute_script("return document.querySelectorAll('*').length")
    assert count <= max_nodes, \
        f'[PERFORMANCE] {count} nœuds DOM, dépasse le budget de {max_nodes} — un DOM trop large ralentit le style/layout/repaint, surtout sur mobile bas de gamme'


def check_first_contentful_paint(driver, budget_ms: int = 2500) -> None:
    """First Contentful Paint — le moment où l'utilisateur voit enfin quelque chose. Mauvais
    FCP = impression de site lent même si le reste charge vite."""
    fcp = driver.execute_script("""
        const entry = performance.getEntriesByType('paint').find(e => e.name === 'first-contentful-paint');
        return entry ? entry.startTime : null;
    """)
    if fcp is None:
        return  # API non disponible sur ce navigateur — pas un échec
    assert fcp <= budget_ms, \
        f'[PERFORMANCE] First Contentful Paint à {fcp:.0f}ms, dépasse le budget de {budget_ms}ms — l\'utilisateur voit un écran vide pendant ce temps, donne une impression de lenteur même si le reste charge vite'


def check_gzip_compression(api, url: str) -> None:
    """Une réponse HTML/CSS/JS non compressée multiplie la bande passante utilisée et le
    temps de téléchargement par 3 à 10x sans aucune raison."""
    r = api.get(url, timeout=10, headers={'Accept-Encoding': 'gzip, br'})
    encoding = r.headers.get('Content-Encoding', '')
    assert encoding, \
        f'[PERFORMANCE] pas de compression (Content-Encoding absent) sur {url} — la réponse est envoyée en clair, 3 à 10x plus de données que nécessaire. Fix : activer gzip/brotli au niveau du serveur web.'
