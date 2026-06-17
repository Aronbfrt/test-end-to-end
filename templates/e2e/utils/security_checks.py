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
    'strict-transport-security': 'Strict-Transport-Security (HSTS) manquant — un attaquant en MITM peut forcer un downgrade vers http et intercepter le trafic',
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
    import os
    hints = [h.strip() for h in os.getenv('TEST_AUTH_URL_HINTS', 'login,signin,connexion,auth,session').split(',')]
    driver.get(base_url + admin_path)
    body = driver.page_source.lower()
    current_url = driver.current_url.lower()
    on_login_page = any(hint in current_url for hint in hints)
    # both conditions required together — a login page that merely *mentions* "tableau de
    # bord" in its copy (e.g. "connecte-toi pour accéder au tableau de bord") must not count
    # as a bypass just because the words appear somewhere in the page.
    looks_authenticated = ('tableau de bord' in body or 'dashboard' in body) and not on_login_page
    assert not looks_authenticated, \
        f"[SÉCURITÉ] {admin_path} accessible sans authentification — bypass complet de l'accès admin. Fix : appliquer un middleware/garde d'authentification sur chaque route admin."


def check_secure_cookies(headers_or_response) -> None:
    """Vérifie les flags Secure/HttpOnly/SameSite sur chaque cookie posé par la réponse.
    `headers_or_response` — une `requests.Response` (utiliser la fixture `api`, pas Selenium :
    document.cookie ne montre jamais les cookies HttpOnly, donc Selenium ne peut pas les voir —
    c'est précisément pour ça qu'il faut vérifier côté HTTP brut, pas dans le navigateur)."""
    set_cookie_headers = headers_or_response.raw.headers.get_all('Set-Cookie') if hasattr(headers_or_response, 'raw') else []
    if not set_cookie_headers:
        set_cookie = headers_or_response.headers.get('Set-Cookie')
        set_cookie_headers = [set_cookie] if set_cookie else []
    if not set_cookie_headers:
        return  # cette réponse ne pose aucun cookie — rien à vérifier, pas un échec
    problems = []
    for cookie in set_cookie_headers:
        lower = cookie.lower()
        name = cookie.split('=')[0]
        if 'secure' not in lower:
            problems.append(f'{name}: pas de flag Secure (envoyé même en clair sur http)')
        if 'httponly' not in lower:
            problems.append(f'{name}: pas de flag HttpOnly (lisible par un script — vol via XSS)')
        if 'samesite' not in lower:
            problems.append(f'{name}: pas de flag SameSite (vulnérable au CSRF cross-site)')
    assert not problems, (
        '[SÉCURITÉ] cookie(s) mal protégés : ' + '; '.join(problems) +
        ' — Fix : Set-Cookie: ...; Secure; HttpOnly; SameSite=Lax (ou Strict).'
    )


def check_no_server_version_leak(headers: dict) -> None:
    """Un header 'Server: Apache/2.4.41' ou 'X-Powered-By: PHP/7.2.1' donne à un attaquant
    la version exacte à cibler avec des CVE connues, au lieu de devoir deviner."""
    import re
    lower = {k.lower(): v for k, v in headers.items()}
    leaks = []
    for key in ('server', 'x-powered-by'):
        value = lower.get(key, '')
        if re.search(r'\d+\.\d+', value):
            leaks.append(f'{key}: {value}')
    assert not leaks, (
        f'[SÉCURITÉ] version de logiciel exposée dans les headers : {leaks} — '
        "cible directement les CVE connues de cette version exacte. "
        "Fix : masquer la version (ServerTokens Prod sur Apache, expose_php=Off sur PHP, server_tokens off sur nginx)."
    )


def check_no_open_redirect(api, base_url: str, redirect_params: list[str] | None = None) -> None:
    """Teste les paramètres de redirection courants (?next=, ?return_url=, ?redirect=...) avec
    une URL externe — si le serveur redirige réellement vers ce domaine, c'est un open redirect
    exploitable pour du phishing (le lien part bien du domaine de confiance, le clic atterrit ailleurs)."""
    redirect_params = redirect_params or ['next', 'return_url', 'redirect', 'redirect_url', 'url', 'continue']
    evil = 'https://evil-example-attacker.test'
    vulnerable = []
    for param in redirect_params:
        try:
            r = api.get(f'{base_url}/?{param}={evil}', timeout=5, allow_redirects=False)
            location = r.headers.get('Location', '')
            if location.startswith(evil):
                vulnerable.append(param)
        except Exception:
            continue
    assert not vulnerable, (
        f"[SÉCURITÉ] paramètre(s) de redirection ouverte exploitable(s) : {vulnerable} — "
        "un lien partant du domaine de confiance peut rediriger vers un site de phishing. "
        "Fix : valider que la cible de redirection est bien sur le même domaine (allowlist), jamais une URL arbitraire."
    )


def check_no_directory_listing(api, base_url: str, paths: list[str] | None = None) -> None:
    """Vérifie que les dossiers d'upload/assets courants ne listent pas leur contenu —
    une listing ouverte expose la structure et parfois des fichiers jamais censés être publics."""
    paths = paths or ['/uploads/', '/images/', '/assets/', '/files/', '/media/', '/backup/', '/backups/']
    exposed = []
    for path in paths:
        try:
            r = api.get(base_url + path, timeout=5)
            if r.status_code == 200 and ('index of' in r.text.lower() or '<title>directory listing' in r.text.lower()):
                exposed.append(path)
        except Exception:
            continue
    assert not exposed, (
        f"[SÉCURITÉ] listing de répertoire exposé : {exposed} — "
        "révèle tous les fichiers du dossier à n'importe qui demande l'URL, y compris des fichiers jamais censés être publics. "
        "Fix : désactiver l'autoindex (Options -Indexes sur Apache, autoindex off sur nginx)."
    )


def check_cors_not_permissive(headers: dict) -> None:
    """Access-Control-Allow-Origin: * combiné à Access-Control-Allow-Credentials: true est
    une vraie vulnérabilité — n'importe quel site peut lire des réponses authentifiées
    (cookies/session) faites en cross-origin depuis le navigateur de la victime."""
    lower = {k.lower(): v for k, v in headers.items()}
    origin = lower.get('access-control-allow-origin', '')
    credentials = lower.get('access-control-allow-credentials', '').lower()
    assert not (origin == '*' and credentials == 'true'), (
        "[SÉCURITÉ] Access-Control-Allow-Origin: * combiné à Access-Control-Allow-Credentials: true — "
        "n'importe quel site peut lire des réponses authentifiées faites en cross-origin depuis le navigateur d'une victime connectée. "
        "Fix : remplacer le wildcard par une allowlist explicite de domaines de confiance."
    )
