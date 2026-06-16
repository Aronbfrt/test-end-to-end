"""Stripe test-mode helpers — test cards, Elements iframe filling, optional Stripe CLI webhook listener.
https://stripe.com/docs/testing — never use against live keys.
"""
import re
import subprocess
import time
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from tests.utils.helpers import wait_for

CARD_SUCCESS  = '4242424242424242'
CARD_DECLINED = '4000000000000002'
CARD_3DS      = '4000002500003155'
CARD_EXPIRE   = '0226'  # MM/YY — far future
CARD_CVC      = '424'


def fill_stripe_iframe(driver, card: str, expiry: str = CARD_EXPIRE, cvc: str = CARD_CVC) -> None:
    WebDriverWait(driver, 15).until(EC.frame_to_be_available_and_switch_to_it(
        (By.CSS_SELECTOR, 'iframe[name*=__privateStripeFrame], iframe[src*=stripe]')
    ))
    wait_for(driver, '[name=cardnumber], [placeholder*=card]')
    driver.find_element(By.CSS_SELECTOR, '[name=cardnumber], [placeholder*=card]').send_keys(card)
    driver.find_element(By.CSS_SELECTOR, '[name=exp-date], [placeholder*=MM]').send_keys(expiry)
    driver.find_element(By.CSS_SELECTOR, '[name=cvc], [placeholder*=CVC]').send_keys(cvc)
    driver.switch_to.default_content()


# ── Optional: Stripe CLI webhook listener — only needed if the project tests webhooks locally.
# Delete this section if the project doesn't run `stripe listen`.

def start_listener(base_url: str, forward_path: str = '/stripe/webhook'):
    """Starts `stripe listen` and captures the webhook signing secret. Returns (process, secret)."""
    try:
        proc = subprocess.Popen(
            ['stripe', 'listen', '--forward-to', f'{base_url}{forward_path}'],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        )
    except FileNotFoundError:
        print('[stripe] Stripe CLI not installed — skipping webhook listener. '
              'Install: https://stripe.com/docs/stripe-cli')
        return None, None

    secret = None
    deadline = time.time() + 15
    while time.time() < deadline:
        line = proc.stdout.readline()
        if not line:
            continue
        m = re.search(r'(whsec_\w+)', line)
        if m:
            secret = m.group(1)
            break
    return proc, secret


def update_yml_secret(secret: str, yml_path: str = 'src/main/resources/application-local.yml') -> None:
    """Injects the webhook secret into a Spring Boot application-local.yml. Adapt path/format per stack."""
    try:
        with open(yml_path, 'r') as f:
            content = f.read()
        content = re.sub(r'webhook-secret:\s*\S+', f'webhook-secret: {secret}', content)
        with open(yml_path, 'w') as f:
            f.write(content)
    except FileNotFoundError:
        print(f'[stripe] {yml_path} not found — set the webhook secret manually: {secret}')
