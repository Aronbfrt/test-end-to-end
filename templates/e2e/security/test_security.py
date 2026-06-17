"""Security — non-destructive probes (headers, sensitive paths, debug exposure, admin
bypass, cookies, open redirect, directory listing, CORS). SQLi/XSS probes against specific
forms live in `/e2e-audit`-generated files named after the form (e.g.
test_security_contact_form.py) since they need real field locators. Never run against
prod — TEST_BASE_URL must point to local/dev."""
import os
import pytest
from tests.utils.helpers import url, BASE_URL
from tests.utils.security_checks import (
    check_security_headers, check_no_sensitive_path_exposed,
    check_no_debug_mode_banner, check_admin_requires_auth,
    check_secure_cookies, check_no_server_version_leak,
    check_no_open_redirect, check_no_directory_listing, check_cors_not_permissive,
)

ADMIN_PATH  = os.getenv('TEST_ADMIN_DASHBOARD_PATH', '')
LOGIN_PATH  = os.getenv('TEST_LOGIN_PATH', '/login')


@pytest.mark.security
class TestSecurityHeaders:

    def test_01_homepage_security_headers(self, api):
        r = api.get(BASE_URL + '/')
        check_security_headers(r.headers)

    def test_02_no_server_version_leak(self, api):
        r = api.get(BASE_URL + '/')
        check_no_server_version_leak(r.headers)

    def test_03_cors_not_permissive(self, api):
        r = api.get(BASE_URL + '/')
        check_cors_not_permissive(r.headers)


@pytest.mark.security
class TestCookies:

    def test_01_secure_cookie_flags(self, api):
        # check_secure_cookies elle-même ne fait rien si la réponse ne pose aucun cookie —
        # pas un skip à gérer ici, juste un passe-plat vers le check.
        r = api.get(BASE_URL + LOGIN_PATH)
        check_secure_cookies(r)


@pytest.mark.security
class TestSensitiveExposure:

    def test_01_no_sensitive_paths_exposed(self, api):
        check_no_sensitive_path_exposed(api, BASE_URL)

    def test_02_no_debug_banner_on_homepage(self, user_driver):
        user_driver.get(url('/'))
        check_no_debug_mode_banner(user_driver)

    def test_03_no_directory_listing(self, api):
        check_no_directory_listing(api, BASE_URL)


@pytest.mark.security
class TestRedirects:

    def test_01_no_open_redirect(self, api):
        check_no_open_redirect(api, BASE_URL)


@pytest.mark.security
class TestAuthBypass:

    def test_01_admin_dashboard_requires_auth(self, guest_driver):
        if not ADMIN_PATH:
            pytest.skip('No admin area — set TEST_ADMIN_DASHBOARD_PATH to enable')
        check_admin_requires_auth(guest_driver, ADMIN_PATH, BASE_URL)
