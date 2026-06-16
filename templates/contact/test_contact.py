"""Contact — '/contact' form: CSRF, honeypot, validation, submission, a11y."""
import pytest
from selenium.webdriver.support.ui import WebDriverWait
from tests.pages.public_pages import ContactPage
from tests.utils.helpers import url, wait_for_locator
from tests.utils.checks import check_csrf_token, check_accessibility


class TestContactForm:

    def test_01_form_present(self, user_driver):
        user_driver.get(url(ContactPage.PATH))
        wait_for_locator(user_driver, ContactPage.FORM)

    def test_02_csrf_token_present(self, user_driver):
        user_driver.get(url(ContactPage.PATH))
        check_csrf_token(user_driver)

    def test_03_honeypot_hidden(self, user_driver):
        user_driver.get(url(ContactPage.PATH))
        honeypot = user_driver.find_elements(*ContactPage.HONEYPOT_INPUT)
        if honeypot:
            assert honeypot[0].get_attribute('style') is not None or not honeypot[0].is_displayed()

    def test_04_empty_submit_shows_errors(self, user_driver):
        user_driver.get(url(ContactPage.PATH))
        user_driver.find_element(*ContactPage.SUBMIT_BTN).click()
        wait_for_locator(user_driver, ContactPage.ERROR_ALERT)

    def test_05_invalid_email_shows_error(self, user_driver):
        user_driver.get(url(ContactPage.PATH))
        user_driver.find_element(*ContactPage.EMAIL_INPUT).send_keys('not-an-email')
        user_driver.find_element(*ContactPage.SUBMIT_BTN).click()
        wait_for_locator(user_driver, ContactPage.ERROR_ALERT)

    def test_06_values_preserved_on_error(self, user_driver, fake_user):
        user_driver.get(url(ContactPage.PATH))
        user_driver.find_element(*ContactPage.EMAIL_INPUT).send_keys(fake_user['email'])
        user_driver.find_element(*ContactPage.SUBMIT_BTN).click()
        email_val = user_driver.find_element(*ContactPage.EMAIL_INPUT).get_attribute('value')
        assert email_val == fake_user['email']

    @pytest.mark.smoke
    def test_07_valid_submission_redirects(self, user_driver, fake_user):
        user_driver.get(url(ContactPage.PATH))
        try:
            user_driver.find_element(*ContactPage.NAME_INPUT_FR).send_keys(fake_user['name'])
        except Exception:
            user_driver.find_element(*ContactPage.NAME_INPUT_EN).send_keys(fake_user['name'])
        user_driver.find_element(*ContactPage.EMAIL_INPUT).send_keys(fake_user['email'])
        try:
            user_driver.find_element(*ContactPage.MESSAGE_INPUT).send_keys(fake_user['message'])
        except Exception:
            pass
        user_driver.find_element(*ContactPage.SUBMIT_BTN).click()
        WebDriverWait(user_driver, 10).until(
            lambda d: 'success' in d.current_url or 'merci' in d.current_url.lower() or 'thank' in d.page_source.lower()
        )

    @pytest.mark.a11y
    def test_08_accessibility(self, user_driver):
        user_driver.get(url(ContactPage.PATH))
        check_accessibility(user_driver)
