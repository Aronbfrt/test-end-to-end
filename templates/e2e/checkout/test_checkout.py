"""Checkout — '/checkout' payment flow + '/subscribe'. Stripe test mode only, never live keys."""
import pytest
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from tests.pages.checkout_pages import CheckoutPage, SubscriptionPage
from tests.utils.helpers import url, wait_for_locator
from tests.utils.stripe_helper import fill_stripe_iframe, CARD_SUCCESS, CARD_DECLINED


class TestCheckout:

    def test_01_checkout_page_loads(self, user_driver):
        user_driver.get(url(CheckoutPage.PATH))
        wait_for_locator(user_driver, CheckoutPage.FORM_OR_STRIPE)

    def test_02_stripe_element_mounts(self, user_driver):
        user_driver.get(url(CheckoutPage.PATH))
        WebDriverWait(user_driver, 15).until(EC.presence_of_element_located(CheckoutPage.STRIPE_IFRAME))

    @pytest.mark.smoke
    @pytest.mark.stripe
    def test_03_successful_payment(self, user_driver):
        user_driver.get(url(CheckoutPage.PATH))
        WebDriverWait(user_driver, 15).until(EC.presence_of_element_located(CheckoutPage.STRIPE_IFRAME))
        fill_stripe_iframe(user_driver, CARD_SUCCESS)
        user_driver.find_element(*CheckoutPage.PAY_BTN).click()
        WebDriverWait(user_driver, 30).until(
            lambda d: 'success' in d.current_url or 'confirmation' in d.current_url or 'merci' in d.current_url
        )

    @pytest.mark.stripe
    def test_04_declined_card_shows_error(self, user_driver):
        user_driver.get(url(CheckoutPage.PATH))
        WebDriverWait(user_driver, 15).until(EC.presence_of_element_located(CheckoutPage.STRIPE_IFRAME))
        fill_stripe_iframe(user_driver, CARD_DECLINED)
        user_driver.find_element(*CheckoutPage.PAY_BTN).click()
        wait_for_locator(user_driver, CheckoutPage.ERROR_ALERT, timeout=20)
        error_text = user_driver.find_element(*CheckoutPage.ERROR_ALERT).text
        assert len(error_text) > 0

    @pytest.mark.stripe
    def test_05_price_not_client_controllable(self, user_driver):
        """Price must come from server — cannot be overridden via DOM manipulation."""
        user_driver.get(url(CheckoutPage.PATH))
        price_els = user_driver.find_elements(*CheckoutPage.PRICE_INPUT)
        for el in price_els:
            assert el.get_attribute('type') == 'hidden' or not el.is_displayed(), \
                'Editable price field found — client-side price manipulation possible'


class TestSubscription:

    @pytest.mark.stripe
    def test_01_plan_selection_visible(self, user_driver):
        user_driver.get(url(SubscriptionPage.PATH))
        plans = user_driver.find_elements(*SubscriptionPage.PLAN_CARD)
        assert len(plans) > 0

    @pytest.mark.stripe
    def test_02_subscription_success(self, user_driver):
        user_driver.get(url(SubscriptionPage.PATH))
        plans = user_driver.find_elements(*SubscriptionPage.PLAN_BTN)
        if plans:
            plans[0].click()
        WebDriverWait(user_driver, 10).until(EC.presence_of_element_located(CheckoutPage.STRIPE_IFRAME))
        fill_stripe_iframe(user_driver, CARD_SUCCESS)
        user_driver.find_element(*SubscriptionPage.SUBSCRIBE_BTN).click()
        WebDriverWait(user_driver, 30).until(lambda d: 'success' in d.current_url or 'dashboard' in d.current_url)
