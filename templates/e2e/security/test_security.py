"""Security — non-destructive probes (headers, sensitive paths, debug exposure, admin
bypass). SQLi/XSS probes against specific forms live in `/e2e-audit`-generated files
named after the form (e.g. test_security_contact_form.py) since they need real field
locators. Never run against prod — TEST_BASE_URL must point to local/dev."""
import pytest
from tests.pages.admin_pages import DashboardPage
from tests.utils.helpers import url, BASE_URL
from tests.utils.security_checks import (
    check_security_headers, check_no_sensitive_path_exposed,
    check_no_debug_mode_banner, check_admin_requires_auth,
)


@pytest.mark.security
class TestSecurityHeaders:

    def test_01_homepage_security_headers(self, api):
        r = api.get(BASE_URL + '/')
        check_security_headers(r.headers)


@pytest.mark.security
class TestSensitiveExposure:

    def test_01_no_sensitive_paths_exposed(self, api):
        check_no_sensitive_path_exposed(api, BASE_URL)

    def test_02_no_debug_banner_on_homepage(self, user_driver):
        user_driver.get(url('/'))
        check_no_debug_mode_banner(user_driver)


@pytest.mark.security
class TestAuthBypass:

    def test_01_admin_dashboard_requires_auth(self, guest_driver):
        check_admin_requires_auth(guest_driver, DashboardPage.PATH, BASE_URL)
