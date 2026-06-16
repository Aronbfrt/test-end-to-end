"""Checks sécurité — sondes non-destructives uniquement. Jamais contre la prod (.env.test doit
pointer vers une instance locale/dev). Chaque assertion explique le risque + pourquoi ça
compte, pour qu'un échec dans le rapport HTML s'explique seul sans fouiller le code.
Tag les tests @pytest.mark.security.
"""
from selenium.webdriver.common.by import By

SQL_ERROR_MARKERS = [
    'sql syntax', 'mysql_fetch', 'you have an error in your sql syntax',
    'ora-01756', 'ora-00933', 'unclosed quotation mark', 'sqlite3.operationalerror',
    'pg::syntaxerror', 'syntax error at or near',
]
SQLI_PROBES = ["'", "' OR '1'='1", '" OR "1"="1', "1' --", "'; DROP TABLE x; --"]
XSS_PROBE = '<script>__e2e_xss_probe_9f3a__</script>'

SECURITY_HEADERS = {
    'x-frame-options': 'X-Frame-Options manquant — la page peut être embarquée dans une iframe malveillante (clickjacking)',
    'x-content-type-options': 'X-Content-Type-Options: nosniff manquant — le navigateur peut deviner le type MIME et exécuter un script déguisé',
    'content-security-policy': 'Content-Security-Policy manquant — aucune défense en profondeur contre les scripts injectés',
    'referrer-policy': 'Referrer-Policy manquant — les URLs complètes (potentiellement avec tokens) fuient vers des sites tiers via l\'en-tête Referer',
}


def check_no_sql_error_leak(driver, input_locator: tuple, submit_locator: tuple, url_to_load: str | None = None) -> None:
    """Soumet des chaînes inoffensives en forme d'injection SQL dans un champ et vérifie que
    la réponse ne fuite pas une erreur BDD brute — ce message d'erreur est lui-même une
    divulgation d'information, et l'absence de paramétrage sous-jacente est un risque d'injection SQL."""
    for probe in SQLI_PROBES:
        if url_to_load:
            driver.get(url_to_load)
        el = driver.find_element(*input_locator)
        el.clear()
        el.send_keys(probe)
        driver.find_element(*submit_locator).click()
        src = driver.page_source.lower()
        leaked = [m for m in SQL_ERROR_MARKERS if m in src]
        assert not leaked, (
            f"[SÉCURITÉ] erreur SQL brute divulguée après soumission de {probe!r} : « {leaked[0]} » — "
            "indique une requête non paramétrée ET divulgue des détails internes de la BDD à un attaquant. "
            "Fix : utiliser des requêtes préparées/paramétrées, jamais concaténer l'input utilisateur dans du SQL."
        )


def check_reflected_input_escaped(driver, input_locator: tuple, submit_locator: tuple, url_to_load: str | None = None) -> None:
    """Soumet un marqueur <script> inoffensif et vérifie qu'il revient échappé en HTML, pas
    comme une balise active — une valeur réfléchie non échappée est un vecteur XSS stocké/réfléchi."""
    if url_to_load:
        driver.get(url_to_load)
    el = driver.find_element(*input_locator)
    el.clear()
    el.send_keys(XSS_PROBE)
    driver.find_element(*submit_locator).click()
    src = driver.page_source
    assert XSS_PROBE not in src, (
        "[SÉCURITÉ] input réfléchi non échappé dans la réponse — XSS réfléchi confirmé. "
        "Une balise <script> contrôlée par l'attaquant s'exécute dans le navigateur de la victime. "
        "Fix : échapper tout input utilisateur à l'affichage (htmlspecialchars() en PHP, Thymeleaf [[...]] pas [(...)], échappement par défaut de React)."
    )


def check_security_headers(headers: dict) -> None:
    """`headers` — un dict issu de `requests.get(url).headers` (utiliser la fixture `api`, pas
    Selenium, les headers HTTP ne sont pas exposés au JS)."""
    lower = {k.lower(): v for k, v in headers.items()}
    missing = [msg for key, msg in SECURITY_HEADERS.items() if key not in lower]
    assert not missing, '[SÉCURITÉ] ' + '; '.join(missing)


def check_no_sensitive_path_exposed(api, base_url: str, paths: list[str] | None = None) -> None:
    """Vérifie que les fichiers sensibles courants ne sont pas servis (.env, .git/config, endpoints debug)."""
    paths = paths or ['/.env', '/.git/config', '/.git/HEAD', '/composer.json', '/package.json', '/phpinfo.php']
    exposed = []
    for path in paths:
        try:
            r = api.get(base_url + path, timeout=5)
            if r.status_code == 200 and len(r.text) > 0:
                exposed.append(path)
        except Exception:
            continue
    assert not exposed, (
        f"[SÉCURITÉ] chemin(s) sensible(s) servi(s) publiquement : {exposed} — "
        "fuite de secrets/identifiants ou de structure interne à quiconque demande l'URL. "
        "Fix : bloquer ces chemins au niveau du serveur web (règle deny nginx/Apache) ou les sortir de la racine web."
    )


def check_no_debug_mode_banner(driver) -> None:
    src = driver.page_source
    markers = ['Whitelabel Error Page', 'Stack trace:', 'Fatal error:', 'Warning: ', 'XDEBUG', 'APP_DEBUG']
    hit = [m for m in markers if m in src]
    assert not hit, (
        f"[SÉCURITÉ] sortie debug/erreur exposée sur une page accessible : {hit} — "
        "les stack traces révèlent chemins de fichiers, versions de framework, et parfois des identifiants. "
        "Fix : désactiver le mode debug / display_errors hors dev local."
    )


def check_admin_requires_auth(driver, admin_path: str, base_url: str) -> None:
    driver.get(base_url + admin_path)
    body = driver.page_source.lower()
    current_url = driver.current_url.lower()
    on_login_page = 'login' in current_url or 'connexion' in current_url
    # both conditions required together — a login page that merely *mentions* "tableau de
    # bord" in its copy (e.g. "connecte-toi pour accéder au tableau de bord") must not count
    # as a bypass just because the words appear somewhere in the page.
    looks_authenticated = ('tableau de bord' in body or 'dashboard' in body) and not on_login_page
    assert not looks_authenticated, \
        f"[SÉCURITÉ] {admin_path} accessible sans authentification — bypass complet de l'accès admin. Fix : appliquer un middleware/garde d'authentification sur chaque route admin."
