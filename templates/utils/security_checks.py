"""Security checks — non-destructive probes only. Never run against prod (.env.test should
point to a local/dev instance). Every assertion explains the risk + why it matters, so a
failure in the HTML report is self-explanatory without digging through code.
Tag tests with @pytest.mark.security.
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
    'x-frame-options': 'missing X-Frame-Options — page can be embedded in a malicious iframe (clickjacking)',
    'x-content-type-options': 'missing X-Content-Type-Options: nosniff — browser may MIME-sniff and execute disguised scripts',
    'content-security-policy': 'missing Content-Security-Policy — no defense-in-depth against injected scripts',
    'referrer-policy': 'missing Referrer-Policy — full URLs (possibly with tokens) leak to third-party sites via the Referer header',
}


def check_no_sql_error_leak(driver, input_locator: tuple, submit_locator: tuple, url_to_load: str | None = None) -> None:
    """Submits harmless SQLi-shaped strings into a field and checks the response doesn't
    leak a raw DB error — that error message itself is information disclosure, and the
    underlying lack of parameterization is a SQL injection risk."""
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
            f"[SECURITY] raw SQL error leaked after submitting {probe!r}: '{leaked[0]}' — "
            "indicates an unparameterized query AND discloses DB internals to an attacker. "
            "Fix: use prepared statements / parameterized queries, never concatenate user input into SQL."
        )


def check_reflected_input_escaped(driver, input_locator: tuple, submit_locator: tuple, url_to_load: str | None = None) -> None:
    """Submits a harmless <script> marker and checks it comes back HTML-escaped, not as a
    live tag — a reflected, unescaped value is a stored/reflected XSS vector."""
    if url_to_load:
        driver.get(url_to_load)
    el = driver.find_element(*input_locator)
    el.clear()
    el.send_keys(XSS_PROBE)
    driver.find_element(*submit_locator).click()
    src = driver.page_source
    assert XSS_PROBE not in src, (
        f"[SECURITY] input reflected unescaped in the response — confirmed reflected XSS. "
        "An attacker-controlled <script> tag executes in the victim's browser. "
        "Fix: HTML-escape all user input on output (htmlspecialchars() in PHP, Thymeleaf [[...]] not [(...)], React default escaping)."
    )


def check_security_headers(headers: dict) -> None:
    """`headers` — a dict from `requests.get(url).headers` (use the `api` fixture, not Selenium,
    headers aren't exposed to JS)."""
    lower = {k.lower(): v for k, v in headers.items()}
    missing = [msg for key, msg in SECURITY_HEADERS.items() if key not in lower]
    assert not missing, '[SECURITY] ' + '; '.join(missing)


def check_no_sensitive_path_exposed(api, base_url: str, paths: list[str] | None = None) -> None:
    """Checks common sensitive files aren't served (.env, .git/config, debug endpoints)."""
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
        f"[SECURITY] sensitive path(s) publicly served: {exposed} — "
        "leaks secrets/credentials or internal structure to anyone who requests the URL. "
        "Fix: block these paths at the web server level (nginx/Apache deny rule) or move them outside the web root."
    )


def check_no_debug_mode_banner(driver) -> None:
    src = driver.page_source
    markers = ['Whitelabel Error Page', 'Stack trace:', 'Fatal error:', 'Warning: ', 'XDEBUG', 'APP_DEBUG']
    hit = [m for m in markers if m in src]
    assert not hit, (
        f"[SECURITY] debug/error output exposed in production-reachable page: {hit} — "
        "stack traces reveal file paths, framework versions, and sometimes credentials. "
        "Fix: disable debug mode / display_errors outside local dev."
    )


def check_admin_requires_auth(driver, admin_path: str, base_url: str) -> None:
    driver.get(base_url + admin_path)
    body = driver.page_source.lower()
    looks_authenticated = 'tableau de bord' in body or 'dashboard' in body and 'login' not in driver.current_url.lower()
    assert not looks_authenticated or 'login' in driver.current_url.lower() or 'connexion' in driver.current_url.lower(), \
        f"[SECURITY] {admin_path} reachable without authentication — full admin access bypass. Fix: enforce auth middleware/guard on every admin route."
