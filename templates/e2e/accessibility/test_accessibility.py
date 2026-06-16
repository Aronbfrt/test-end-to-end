"""Accessibility — axe-core sweep across the routes that don't already declare their own
a11y test in their domain folder. Add new routes here as the project grows."""
import pytest
from tests.pages.public_pages import HomePage
from tests.pages.admin_pages import DashboardPage
from tests.utils.helpers import url
from tests.utils.checks import check_accessibility

EXTRA_PAGES = [
    # ('/about', 'About'),  # add routes that don't have their own domain folder yet
]


@pytest.mark.a11y
class TestAccessibilitySweep:
    @pytest.mark.parametrize('path,name', EXTRA_PAGES)
    def test_01_no_critical_violations(self, user_driver, path, name):
        user_driver.get(url(path))
        check_accessibility(user_driver)
