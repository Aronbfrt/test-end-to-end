"""Page Object — checkout, subscription, Stripe Elements."""
from selenium.webdriver.common.by import By


class CheckoutPage:
    PATH           = '/checkout'
    FORM_OR_STRIPE = (By.CSS_SELECTOR, 'form, [data-stripe]')
    STRIPE_IFRAME  = (By.CSS_SELECTOR, 'iframe[src*=stripe]')
    PAY_BTN        = (By.CSS_SELECTOR, '[type=submit], #pay-button')
    ERROR_ALERT    = (By.CSS_SELECTOR, '[role=alert], .error, .stripe-error')
    PRICE_INPUT    = (By.CSS_SELECTOR, 'input[name=amount], input[name=price]')


class SubscriptionPage:
    PATH         = '/subscribe'
    PLAN_CARD    = (By.CSS_SELECTOR, '[data-plan], .plan-card, .pricing-card')
    PLAN_BTN     = (By.CSS_SELECTOR, '[data-plan], .plan-card button')
    SUBSCRIBE_BTN = (By.CSS_SELECTOR, '[type=submit], #subscribe-button')
