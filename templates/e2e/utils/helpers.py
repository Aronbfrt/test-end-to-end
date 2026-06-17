"""Generic, project-agnostic helpers. Import from any test file."""
import os
from urllib.parse import urlparse
from dotenv import load_dotenv
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC

# Loaded here too (not just in conftest.py) so BASE_URL is correct even if this module gets
# imported before conftest.py's load_dotenv() runs — import order isn't guaranteed otherwise.
load_dotenv('.env.test')

BASE_URL = os.environ.get('TEST_BASE_URL', 'http://localhost:8000')


def url(path: str) -> str:
    return BASE_URL + path


def body_text(driver) -> str:
    try:
        return driver.find_element(By.TAG_NAME, 'body').text
    except Exception:
        return ''


def fill(driver, name: str, value: str) -> None:
    el = driver.find_element(By.NAME, name)
    el.clear()
    el.send_keys(value)


def fill_by_id(driver, element_id: str, value: str) -> None:
    el = driver.find_element(By.ID, element_id)
    el.clear()
    el.send_keys(value)


def click_submit(driver) -> None:
    """Finds the first non-search submit button and submits its parent form."""
    btns = driver.find_elements(By.CSS_SELECTOR, "button[type='submit']")
    btn = next(
        (b for b in btns if 'search' not in (b.get_attribute('class') or '').lower()
         and b.get_attribute('aria-label') != 'Rechercher'),
        btns[0] if btns else None,
    )
    if btn is None:
        raise AssertionError('No submit button found on page')
    form = driver.execute_script("return arguments[0].closest('form');", btn)
    if form:
        driver.execute_script('arguments[0].submit();', form)
    else:
        driver.execute_script('arguments[0].scrollIntoView(true);', btn)
        driver.execute_script('arguments[0].click();', btn)


def wait_for(driver, selector: str, by=By.CSS_SELECTOR, timeout: int = 10):
    return WebDriverWait(driver, timeout).until(EC.presence_of_element_located((by, selector)))


def wait_for_locator(driver, locator: tuple, timeout: int = 10):
    """Same as wait_for but takes a Page Object locator tuple directly: (By.X, 'value')."""
    return WebDriverWait(driver, timeout).until(EC.presence_of_element_located(locator))


def login(driver, email: str, password: str, login_path: str = '/login') -> None:
    """Used by conftest's admin_driver fixture and by auth-flow tests. Adapt path/selectors per project."""
    driver.get(url(login_path))
    wait_for(driver, '[name=email]', by=By.CSS_SELECTOR, timeout=10)
    driver.find_element(By.NAME, 'email').send_keys(email)
    driver.find_element(By.NAME, 'password').send_keys(password)
    driver.find_element(By.CSS_SELECTOR, '[type=submit]').click()
    WebDriverWait(driver, 10).until(lambda d: urlparse(d.current_url).path != login_path)


def get_load_time_ms(driver) -> float:
    """Navigation Timing API — total page load time in ms."""
    return driver.execute_script(
        "const t = performance.timing; return t.loadEventEnd - t.navigationStart;"
    )
