"""Driver factory. Selenium 4.6+ Selenium Manager auto-downloads the matching
chromedriver/geckodriver — no manual driver install needed, just a browser binary.
"""
import os
from selenium import webdriver
from selenium.webdriver.chrome.options import Options as ChromeOptions
from selenium.webdriver.firefox.options import Options as FirefoxOptions
from selenium.webdriver.support.ui import WebDriverWait

TIMEOUT = 25

# Headless toggle — set in .env.test (TEST_HEADLESS=1/0), or override per run:
#   TEST_HEADLESS=0 pytest tests/        (visible, debug)
#   TEST_HEADLESS=1 pytest tests/        (headless, CI/server)
HEADLESS = os.environ.get('TEST_HEADLESS', '1') == '1'
BROWSER  = os.environ.get('TEST_BROWSER', 'chrome')   # chrome | firefox

# Explicit metrics instead of a named deviceName — Chrome's built-in device list (Pixel 5,
# iPhone X...) changes between versions and a removed name throws InvalidArgumentException.
# Override via .env.test if a different viewport is needed.
MOBILE_WIDTH  = int(os.environ.get('TEST_MOBILE_WIDTH', '393'))
MOBILE_HEIGHT = int(os.environ.get('TEST_MOBILE_HEIGHT', '851'))
MOBILE_DPR    = float(os.environ.get('TEST_MOBILE_DPR', '2.75'))
MOBILE_UA     = os.environ.get(
    'TEST_MOBILE_UA',
    'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) '
    'Chrome/120.0.0.0 Mobile Safari/537.36',
)


def make_driver(private: bool = False, mobile: bool = False, browser: str = BROWSER) -> webdriver.Remote:
    if browser == 'firefox':
        opts = FirefoxOptions()
        if private:
            opts.add_argument('-private')
        if HEADLESS:
            opts.add_argument('--headless')
        return webdriver.Firefox(options=opts)

    opts = ChromeOptions()
    if private:
        opts.add_argument('--incognito')
    if HEADLESS:
        opts.add_argument('--headless=new')
        opts.add_argument('--blink-settings=imagesEnabled=false')
    opts.add_argument('--no-sandbox')
    opts.add_argument('--disable-dev-shm-usage')
    opts.add_argument('--disable-gpu')
    opts.add_argument('--disable-extensions')
    opts.add_argument('--disable-background-networking')
    opts.add_argument('--disable-backgrounding-occluded-windows')
    opts.add_argument('--disable-renderer-backgrounding')
    opts.add_argument('--js-flags=--max-old-space-size=128')
    opts.add_argument('--disk-cache-size=1')
    opts.add_argument('--log-level=3')
    opts.set_capability('goog:loggingPrefs', {'browser': 'ALL'})
    if mobile:
        opts.add_experimental_option('mobileEmulation', {
            'deviceMetrics': {'width': MOBILE_WIDTH, 'height': MOBILE_HEIGHT, 'pixelRatio': MOBILE_DPR},
            'userAgent': MOBILE_UA,
        })
    else:
        opts.add_argument('--window-size=1280,900')
    return webdriver.Chrome(options=opts)


def purge_driver_memory(driver) -> None:
    """Frees Chrome memory between heavy cycles (long admin/Stripe sessions)."""
    try:
        driver.get('about:blank')
        driver.execute_cdp_cmd('Network.clearBrowserCache', {})
        driver.execute_script("try { window.gc && window.gc(); } catch(e) {}")
    except Exception:
        pass


def clear_state(driver) -> None:
    """Clears cache/localStorage without quitting — used between tests on a shared session driver."""
    try:
        driver.execute_cdp_cmd('Network.clearBrowserCache', {})
        driver.execute_script("try { window.localStorage.clear(); } catch(e) {}")
    except Exception:
        pass


def wait(driver, timeout: int = TIMEOUT) -> WebDriverWait:
    return WebDriverWait(driver, timeout)
