"""Admin — dashboard + user management. admin_driver is session-scoped and ensures
login lazily on first use (see conftest.py admin_driver fixture)."""
import pytest
from selenium.webdriver.support.ui import WebDriverWait
from tests.pages.admin_pages import DashboardPage, UsersPage
from tests.utils.helpers import url, wait_for_locator
from tests.utils.checks import check_accessibility


class TestDashboard:

    @pytest.mark.smoke
    def test_01_dashboard_loads(self, admin_driver):
        admin_driver.get(url(DashboardPage.PATH))
        assert admin_driver.title != ''
        cards = admin_driver.find_elements(*DashboardPage.STAT_CARD)
        assert len(cards) > 0

    def test_02_sidebar_links_present(self, admin_driver):
        admin_driver.get(url(DashboardPage.PATH))
        nav = admin_driver.find_elements(*DashboardPage.SIDEBAR_NAV)
        assert len(nav) >= 3

    @pytest.mark.a11y
    def test_03_accessibility(self, admin_driver):
        admin_driver.get(url(DashboardPage.PATH))
        check_accessibility(admin_driver)


class TestUserManagement:

    def test_01_user_list_loads(self, admin_driver):
        admin_driver.get(url(UsersPage.PATH))
        wait_for_locator(admin_driver, UsersPage.TABLE)

    def test_02_user_list_paginated(self, admin_driver):
        admin_driver.get(url(UsersPage.PATH))
        rows = admin_driver.find_elements(*UsersPage.ROW)
        assert len(rows) <= 25

    def test_03_create_user_form_accessible(self, admin_driver):
        admin_driver.get(url(UsersPage.CREATE_PATH))
        wait_for_locator(admin_driver, UsersPage.EMAIL_INPUT)
        assert admin_driver.find_element(*UsersPage.EMAIL_INPUT)

    def test_04_search_filters_list(self, admin_driver):
        admin_driver.get(url(UsersPage.PATH))
        search = admin_driver.find_elements(*UsersPage.SEARCH_INPUT)
        if search:
            search[0].send_keys('test')
            WebDriverWait(admin_driver, 5).until(lambda d: 'q=test' in d.current_url or 'search=test' in d.current_url)
