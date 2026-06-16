"""Accessibility — axe-core sweep + targeted checks for what keyboard/screen-reader users
actually hit (skip link, form labels, landmarks, aria-hidden traps, unnamed icon buttons).
Add new routes to EXTRA_PAGES as the project grows."""
import pytest
from tests.pages.public_pages import HomePage
from tests.pages.admin_pages import DashboardPage
from tests.utils.helpers import url
from tests.utils.checks import (
    check_accessibility, check_skip_link, check_form_labels,
    check_aria_landmarks, check_no_aria_hidden_focusable, check_button_accessible_name,
)

EXTRA_PAGES = [
    # ('/about', 'About'),  # add routes that don't have their own domain folder yet
]


@pytest.mark.a11y
class TestAccessibilitySweep:
    @pytest.mark.parametrize('path,name', EXTRA_PAGES)
    def test_01_no_critical_violations(self, user_driver, path, name):
        user_driver.get(url(path))
        check_accessibility(user_driver)


@pytest.mark.a11y
class TestHomepageAccessibility:
    """Targeted checks beyond the generic axe-core scan — things real keyboard/screen-reader
    usage hits that a broad automated scan can miss or under-prioritize."""

    def test_01_skip_link_present(self, user_driver):
        user_driver.get(url(HomePage.PATH))
        check_skip_link(user_driver)

    def test_02_form_fields_have_labels(self, user_driver):
        user_driver.get(url(HomePage.PATH))
        check_form_labels(user_driver)

    def test_03_aria_landmarks_present(self, user_driver):
        user_driver.get(url(HomePage.PATH))
        check_aria_landmarks(user_driver)

    def test_04_no_aria_hidden_focusable(self, user_driver):
        user_driver.get(url(HomePage.PATH))
        check_no_aria_hidden_focusable(user_driver)

    def test_05_buttons_have_accessible_name(self, user_driver):
        user_driver.get(url(HomePage.PATH))
        check_button_accessible_name(user_driver)


@pytest.mark.a11y
class TestAdminAccessibility:
    def test_01_form_fields_have_labels(self, admin_driver):
        admin_driver.get(url(DashboardPage.PATH))
        check_form_labels(admin_driver)
