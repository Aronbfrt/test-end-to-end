"""Page Object — login/logout/register. Centralizes selectors: 1 markup change = 1 line edited."""
from selenium.webdriver.common.by import By


class LoginPage:
    PATH          = '/login'
    EMAIL_INPUT   = (By.NAME, 'email')
    PASSWORD_INPUT = (By.NAME, 'password')
    SUBMIT_BTN    = (By.CSS_SELECTOR, '[type=submit]')
    ERROR_ALERT   = (By.CSS_SELECTOR, '[role=alert], .error, .alert-danger')


class RegisterPage:
    PATH               = '/register'
    FIRSTNAME_INPUT    = (By.NAME, 'firstName')
    LASTNAME_INPUT     = (By.NAME, 'lastName')
    EMAIL_INPUT        = (By.NAME, 'email')
    PASSWORD_INPUT     = (By.NAME, 'password')
    CONFIRM_PASS_INPUT = (By.NAME, 'confirmPassword')
    SUBMIT_BTN         = (By.CSS_SELECTOR, '[type=submit]')


class LogoutPage:
    PATH = '/logout'
