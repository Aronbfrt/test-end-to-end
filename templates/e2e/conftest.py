"""tests/conftest.py — constants, fixtures, report enrichment, optional auto-fix retry.
Import convention: every internal import uses the `tests.` prefix (tests/__init__.py makes
this a package; pytest adds the project root to sys.path because of that __init__.py).
"""
import os
import logging
from datetime import datetime

import pytest
import requests
from dotenv import load_dotenv
from faker import Faker

from tests.utils.browser import make_driver, clear_state
from tests.utils.helpers import login, url
from tests.utils import helpers as helpers_module
from tests.utils.auto_fix import check_and_fix

try:
    from pytest_html import extras
except ImportError:
    extras = None

load_dotenv('.env.test')

# ── Config ────────────────────────────────────────────────────────────────────
ADMIN_EMAIL = os.getenv('TEST_ADMIN_EMAIL', 'admin@example.com')
ADMIN_PASS  = os.getenv('TEST_ADMIN_PASS',  'password')
USER_EMAIL  = os.getenv('TEST_USER_EMAIL',  'user@example.com')
USER_PASS   = os.getenv('TEST_USER_PASS',   'password')
API_URL     = os.getenv('TEST_API_URL', helpers_module.BASE_URL)
SCREENSHOTS = os.getenv('TEST_SCREENSHOTS', 'tests/screenshots')
RUN_ID      = datetime.now().strftime('%Y%m%d_%H%M%S')
ADMIN_DASHBOARD_PATH = os.getenv('TEST_ADMIN_DASHBOARD_PATH', '/admin/dashboard')

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s %(levelname)s %(message)s',
    handlers=[logging.FileHandler('tests/tests.log'), logging.StreamHandler()],
)
log = logging.getLogger('e2e')

fake = Faker('fr_FR')   # adapt locale per project


# ── CLI option: override env at runtime (pytest --env=staging) ────────────────
def pytest_addoption(parser):
    parser.addoption('--env', action='store', default=None, help='Override TEST_BASE_URL key (dev/staging/prod)')


def pytest_configure(config):
    env = config.getoption('--env')
    if env:
        override = os.getenv(f'TEST_BASE_URL_{env.upper()}')
        if override:
            helpers_module.BASE_URL = override
            log.info(f'BASE_URL overridden via --env={env}: {override}')


# ── Driver fixtures ─────────────────────────────────────────────────────────
# admin_driver / user_driver are SESSION-scoped: one browser per role for the whole run,
# not one per test. At 300-1000+ tests this is the difference between a 10min and a 4h suite.
# Login happens once (lazily, idempotent), then persists via cookies across the session.
# State leakage between tests is handled by `clear_browser_cache` (cache + localStorage only,
# cookies survive on purpose).

@pytest.fixture(scope='session')
def admin_driver():
    d = make_driver()
    d.get(url(ADMIN_DASHBOARD_PATH))
    if 'login' in d.current_url.lower() or 'connexion' in d.current_url.lower():
        login(d, ADMIN_EMAIL, ADMIN_PASS)
    yield d
    d.quit()


@pytest.fixture(scope='session')
def user_driver():
    """Plain authenticated-or-not session browser — most domain tests call `login()` explicitly
    if they need a fresh, controllable auth state (see pages/auth)."""
    d = make_driver(private=True)
    yield d
    d.quit()


@pytest.fixture(scope='function')
def guest_driver():
    """Fresh browser, function-scoped, never logged in. Use for auth-flow tests
    (login/register/logout/access-control) where shared session state would interfere."""
    d = make_driver(private=True)
    yield d
    d.quit()


@pytest.fixture(scope='function')
def mobile_driver():
    """Fresh browser per test, mobile viewport emulation."""
    d = make_driver(mobile=True)
    yield d
    d.quit()


@pytest.fixture(autouse=True)
def clear_browser_cache(request):
    """Clears cache/localStorage (not cookies) between tests on the shared session drivers —
    prevents memory bloat over hundreds of tests without breaking persisted login."""
    yield
    for fixture_name in ('admin_driver', 'user_driver'):
        d = request.node.funcargs.get(fixture_name)
        if d is not None:
            clear_state(d)


@pytest.fixture(scope='session')
def shared_state():
    """Mutable dict shared across all tests in the session (e.g. a product slug created
    in one test, consumed in another)."""
    return {}


# ── API fixture — direct HTTP for fast setup/teardown, skip UI when possible ──
@pytest.fixture(scope='function')
def api():
    s = requests.Session()
    s.base_url = API_URL
    yield s
    s.close()


# ── Test data fixture ───────────────────────────────────────────────────────
@pytest.fixture
def fake_user():
    """Random but realistic test data (FR locale) — avoids hardcoded fixtures colliding
    across runs and across parallel xdist workers."""
    return {
        'name': fake.name(),
        'email': fake.unique.email(),
        'phone': fake.phone_number(),
        'address': fake.address(),
        'company': fake.company(),
        'message': fake.paragraph(nb_sentences=3),
    }


# ── Report enrichment: embed screenshot + console errors directly in the HTML report ──
@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item, call):
    outcome = yield
    report = outcome.get_result()
    report.extra = getattr(report, 'extra', [])

    if report.when != 'call' or not report.failed:
        return

    driver = next(
        (item.funcargs.get(n) for n in ('admin_driver', 'user_driver', 'guest_driver', 'mobile_driver')
         if item.funcargs.get(n) is not None),
        None,
    )
    if driver is None:
        return

    out_dir = os.path.join(SCREENSHOTS, RUN_ID)
    os.makedirs(out_dir, exist_ok=True)
    name = item.nodeid.replace('/', '_').replace('::', '__')
    path = os.path.join(out_dir, f'{name}.png')
    try:
        driver.save_screenshot(path)
        if extras:
            report.extra.append(extras.image(path))
    except Exception:
        pass

    try:
        errors = [e for e in driver.get_log('browser') if e.get('level') == 'SEVERE']
        if errors and extras:
            report.extra.append(extras.text('\n'.join(str(e)[:300] for e in errors[:5]), name='Console errors'))
    except Exception:
        pass


def pytest_html_report_title(report):
    report.title = 'Test End-to-End — Rapport'


# ── Category column — security/seo/a11y/... visible at a glance, no need to open each row ──
CATEGORY_MARKERS = ['security', 'seo', 'a11y', 'responsive', 'performance', 'admin', 'stripe', 'smoke']


def pytest_html_results_table_header(cells):
    cells.insert(2, '<th>Category</th>')


def pytest_html_results_table_row(report, cells):
    cats = [m for m in CATEGORY_MARKERS if m in report.keywords]
    label = ', '.join(cats) or '-'
    css_class = ' class="cat-security"' if 'security' in cats else ''
    cells.insert(2, f'<td{css_class}>{label}</td>')


# ── Auto-fix hook (mechanism only — empty FIXES by default, see utils/auto_fix.py) ──
@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_call(item):
    outcome = yield
    if outcome.excinfo is None:
        return

    drivers = [item.funcargs.get(n) for n in ('admin_driver', 'user_driver', 'guest_driver', 'mobile_driver')]
    drivers = [d for d in drivers if d is not None]
    if not drivers or not check_and_fix(drivers):
        return

    try:
        item.runtest()
        outcome.force_result(None)
        log.warning(f"[AutoFix] Test '{item.name}' passed after automatic fix")
    except Exception:
        pass  # retry failed too — original exception propagates
