"""Auth — login, register, logout, access control. Uses guest_driver (fresh, function-scoped)
because this domain tests the auth state itself — sharing the session driver here would
mask bugs (a stale logged-in cookie could hide a broken login form)."""
import pytest
from selenium.webdriver.support.ui import WebDriverWait
from tests.conftest import ADMIN_EMAIL, ADMIN_PASS, USER_EMAIL, USER_PASS
from tests.pages.auth_pages import LoginPage, RegisterPage, LogoutPage
from tests.utils.helpers import url, wait_for_locator, body_text


class TestAuth:

    @pytest.mark.smoke
    def test_01_admin_login(self, guest_driver):
        guest_driver.get(url(LoginPage.PATH))
        wait_for_locator(guest_driver, LoginPage.EMAIL_INPUT)
        guest_driver.find_element(*LoginPage.EMAIL_INPUT).send_keys(ADMIN_EMAIL)
        guest_driver.find_element(*LoginPage.PASSWORD_INPUT).send_keys(ADMIN_PASS)
        guest_driver.find_element(*LoginPage.SUBMIT_BTN).click()
        WebDriverWait(guest_driver, 10).until(lambda d: LoginPage.PATH not in d.current_url)

    def test_02_user_register(self, guest_driver, fake_user):
        guest_driver.get(url(RegisterPage.PATH))
        wait_for_locator(guest_driver, RegisterPage.EMAIL_INPUT)
        guest_driver.find_element(*RegisterPage.FIRSTNAME_INPUT).send_keys(fake_user['name'].split()[0])
        guest_driver.find_element(*RegisterPage.LASTNAME_INPUT).send_keys(fake_user['name'].split()[-1])
        guest_driver.find_element(*RegisterPage.EMAIL_INPUT).send_keys(fake_user['email'])
        guest_driver.find_element(*RegisterPage.PASSWORD_INPUT).send_keys(USER_PASS)
        guest_driver.find_element(*RegisterPage.CONFIRM_PASS_INPUT).send_keys(USER_PASS)
        guest_driver.find_element(*RegisterPage.SUBMIT_BTN).click()
        WebDriverWait(guest_driver, 10).until(lambda d: RegisterPage.PATH not in d.current_url)

    def test_03_valid_user_login(self, guest_driver):
        guest_driver.get(url(LoginPage.PATH))
        wait_for_locator(guest_driver, LoginPage.EMAIL_INPUT)
        guest_driver.find_element(*LoginPage.EMAIL_INPUT).send_keys(USER_EMAIL)
        guest_driver.find_element(*LoginPage.PASSWORD_INPUT).send_keys(USER_PASS)
        guest_driver.find_element(*LoginPage.SUBMIT_BTN).click()
        WebDriverWait(guest_driver, 10).until(lambda d: LoginPage.PATH not in d.current_url)

    def test_04_wrong_password_shows_error(self, guest_driver):
        guest_driver.get(url(LoginPage.PATH))
        wait_for_locator(guest_driver, LoginPage.EMAIL_INPUT)
        guest_driver.find_element(*LoginPage.EMAIL_INPUT).send_keys(ADMIN_EMAIL)
        guest_driver.find_element(*LoginPage.PASSWORD_INPUT).send_keys('wrongpassword')
        guest_driver.find_element(*LoginPage.SUBMIT_BTN).click()
        wait_for_locator(guest_driver, LoginPage.ERROR_ALERT)
        assert LoginPage.PATH in guest_driver.current_url

    def test_05_empty_fields_blocked(self, guest_driver):
        guest_driver.get(url(LoginPage.PATH))
        wait_for_locator(guest_driver, LoginPage.SUBMIT_BTN)
        guest_driver.find_element(*LoginPage.SUBMIT_BTN).click()
        assert LoginPage.PATH in guest_driver.current_url

    def test_06_logout_clears_session(self, guest_driver):
        guest_driver.get(url(LoginPage.PATH))
        wait_for_locator(guest_driver, LoginPage.EMAIL_INPUT)
        guest_driver.find_element(*LoginPage.EMAIL_INPUT).send_keys(USER_EMAIL)
        guest_driver.find_element(*LoginPage.PASSWORD_INPUT).send_keys(USER_PASS)
        guest_driver.find_element(*LoginPage.SUBMIT_BTN).click()
        WebDriverWait(guest_driver, 10).until(lambda d: LoginPage.PATH not in d.current_url)
        guest_driver.get(url(LogoutPage.PATH))
        guest_driver.get(url('/dashboard'))
        assert LoginPage.PATH in guest_driver.current_url

    def test_07_unauthenticated_redirected_to_login(self, guest_driver):
        guest_driver.get(url('/dashboard'))
        assert LoginPage.PATH in guest_driver.current_url

    def test_08_user_cannot_access_admin(self, guest_driver):
        guest_driver.get(url(LoginPage.PATH))
        wait_for_locator(guest_driver, LoginPage.EMAIL_INPUT)
        guest_driver.find_element(*LoginPage.EMAIL_INPUT).send_keys(USER_EMAIL)
        guest_driver.find_element(*LoginPage.PASSWORD_INPUT).send_keys(USER_PASS)
        guest_driver.find_element(*LoginPage.SUBMIT_BTN).click()
        WebDriverWait(guest_driver, 10).until(lambda d: LoginPage.PATH not in d.current_url)
        guest_driver.get(url('/admin'))
        assert '/admin' not in guest_driver.current_url or '403' in body_text(guest_driver)
