"""Page Object — home, static pages, navigation, contact form."""
from selenium.webdriver.common.by import By


class HomePage:
    PATH    = '/'
    NAV_LINK = (By.CSS_SELECTOR, 'nav a[href], header a[href]')


class ContactPage:
    PATH            = '/contact'
    FORM            = (By.CSS_SELECTOR, 'form')
    EMAIL_INPUT     = (By.NAME, 'email')
    NAME_INPUT_FR   = (By.NAME, 'nom')
    NAME_INPUT_EN   = (By.NAME, 'name')
    MESSAGE_INPUT   = (By.NAME, 'message')
    SUBMIT_BTN      = (By.CSS_SELECTOR, '[type=submit]')
    CSRF_INPUT      = (By.CSS_SELECTOR, 'input[name=csrf_token], input[name=_token]')
    HONEYPOT_INPUT  = (By.CSS_SELECTOR, 'input[name=website], input[name=_honeypot]')
    ERROR_ALERT     = (By.CSS_SELECTOR, '[role=alert], .error, .invalid-feedback')


class MobileNavPage:
    TOGGLE = (By.CSS_SELECTOR, '[aria-label*=menu], .burger, .hamburger, [data-mobile-nav]')
    PANEL_LINK = (By.CSS_SELECTOR, 'nav a, .mobile-menu a, [data-mobile-nav-panel] a')
