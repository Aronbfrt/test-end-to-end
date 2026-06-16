"""Generic admin CRUD test base. Subclass once per entity in tests/admin_<entity>/test_admin_<entity>.py."""
from selenium.webdriver.common.by import By
from tests.utils.helpers import url, wait_for


class CRUDTestBase:
    RESOURCE        = 'entities'          # adapt: clients, products, orders...
    CREATE_PATH     = '/admin/entities/create'
    LIST_PATH       = '/admin/entities'
    REQUIRED_FIELDS = ['name']

    def test_01_list_accessible(self, admin_driver):
        admin_driver.get(url(self.LIST_PATH))
        assert admin_driver.title != ''

    def test_02_create_form_has_required_fields(self, admin_driver):
        admin_driver.get(url(self.CREATE_PATH))
        for field in self.REQUIRED_FIELDS:
            assert admin_driver.find_element(By.NAME, field)

    def test_03_empty_form_shows_errors(self, admin_driver):
        admin_driver.get(url(self.CREATE_PATH))
        admin_driver.find_element(By.CSS_SELECTOR, '[type=submit]').click()
        wait_for(admin_driver, '.error, [role=alert], .invalid-feedback')
        assert self.CREATE_PATH in admin_driver.current_url

    def test_04_csv_export_available(self, admin_driver):
        admin_driver.get(url(self.LIST_PATH))
        export_btn = admin_driver.find_elements(By.CSS_SELECTOR, 'a[href*=export], a[href*=csv], [data-export]')
        assert len(export_btn) > 0
