"""tests/conftest.py — fixtures, pytest hooks, and feature wiring.

This file is intentionally thin: it is the single entry point pytest discovers,
but each advanced feature lives in its own focused module:

  features/replay.py     → 🎬 animated GIF of last actions before a failure
  features/self_heal.py  → 🩹 one-fallback auto-repair for drifted selectors
  features/flaky.py      → 🎲 cross-run stability detection (JSONL history)
  utils/visual.py        → 👁  pixel diff against stored baseline

Report customisation (columns, JS dashboard, CSS theme):
  report/hooks.py        → column injection helpers
  report/report_theme.js → full custom dashboard JS
  report/report-style.css→ dark theme

Import convention: every internal import uses the `tests.` prefix —
tests/__init__.py makes this a package; pytest adds the project root to sys.path.
"""
import logging
import os
import shutil

import pytest
import requests
from dotenv import load_dotenv
from faker import Faker

from tests.utils.browser import make_driver, clear_state
from tests.utils.helpers import login, url
from tests.utils import helpers as helpers_module
from tests.utils.auto_fix import check_and_fix
from tests.features import replay, self_heal
from tests.features import flaky as flaky_mod
from tests.report import hooks as report_hooks

try:
    from pytest_html import extras
except ImportError:
    extras = None

try:
    from PIL import Image  # noqa: F401 — existence check only
    from tests.utils.visual import check_visual_regression
    _PIL_OK = True
except ImportError:
    check_visual_regression = None
    _PIL_OK = False

load_dotenv('.env.test')

# ── Config ─────────────────────────────────────────────────────────────────────
ADMIN_EMAIL          = os.getenv('TEST_ADMIN_EMAIL', 'admin@example.com')
ADMIN_PASS           = os.getenv('TEST_ADMIN_PASS',  'password')
USER_EMAIL           = os.getenv('TEST_USER_EMAIL',  'user@example.com')
USER_PASS            = os.getenv('TEST_USER_PASS',   'password')
API_URL              = os.getenv('TEST_API_URL', helpers_module.BASE_URL)
SCREENSHOTS          = os.getenv('TEST_SCREENSHOTS', 'tests/screenshots')
ADMIN_DASHBOARD_PATH = os.getenv('TEST_ADMIN_DASHBOARD_PATH', '/admin/dashboard')

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s %(levelname)s %(message)s',
    handlers=[logging.FileHandler('tests/tests.log'), logging.StreamHandler()],
)
log = logging.getLogger('e2e')

fake = Faker('fr_FR')

# ── Feature flags + monkeypatch install ────────────────────────────────────────
# Done once at import time — must happen before any driver is created (before fixtures).
replay.REPLAY_ENABLED = os.getenv('TEST_REPLAY', '1') == '1' and _PIL_OK
SELF_HEAL_ENABLED     = os.getenv('TEST_SELF_HEAL', '1') == '1'
VISUAL_ENABLED        = os.getenv('TEST_VISUAL', '1') == '1' and _PIL_OK

if replay.REPLAY_ENABLED:
    replay.install()
if SELF_HEAL_ENABLED:
    self_heal.install()


# ── Session lifecycle ──────────────────────────────────────────────────────────
def pytest_sessionstart(session):
    flaky_mod.load()                              # read-only, safe under xdist
    if hasattr(session.config, 'workerinput'):
        return                                    # xdist worker — skip destructive ops
    shutil.rmtree(SCREENSHOTS, ignore_errors=True)  # wipe last run's screenshots


def pytest_sessionfinish(session, exitstatus):
    if hasattr(session.config, 'workerinput'):
        return    # xdist: writing history concurrently would race — skip on workers
    flaky_mod.save()


def pytest_addoption(parser):
    parser.addoption('--env', action='store', default=None,
                     help='Override TEST_BASE_URL key (dev/staging/prod)')
    parser.addoption('--headed', action='store_true', default=False,
                     help='Run browser in visible mode (default: headless)')


def pytest_configure(config):
    env = config.getoption('--env')
    if env:
        override = os.getenv(f'TEST_BASE_URL_{env.upper()}')
        if override:
            helpers_module.BASE_URL = override
            log.info(f'BASE_URL overridden via --env={env}: {override}')

    if config.getoption('--headed'):
        from tests.utils import browser as browser_mod
        browser_mod.HEADLESS = False
        log.info('Browser: visible (--headed)')


# ── Test lifecycle hooks ───────────────────────────────────────────────────────
def pytest_runtest_setup(item):
    replay.set_current(item.nodeid)
    replay.clear(item.nodeid)
    self_heal.set_current(item.nodeid)
    self_heal.clear(item.nodeid)


def pytest_runtest_logfinish(nodeid, location):
    # Free memory — buffers only need to survive until pytest_runtest_makereport.
    replay.clear(nodeid)
    self_heal.clear(nodeid)


# ── Driver fixtures ────────────────────────────────────────────────────────────
# admin_driver / user_driver are SESSION-scoped: one browser per role for the whole run.
# Login happens once, persists via cookies. State is wiped between tests by
# clear_browser_cache (cache + localStorage only — cookies survive on purpose).
# guest_driver / mobile_driver are function-scoped for auth-flow / mobile-only tests.

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
    """Shared authenticated-or-not browser. Domain tests call login() explicitly
    when they need a fresh, controllable auth state."""
    d = make_driver(private=True)
    yield d
    d.quit()


@pytest.fixture(scope='function')
def guest_driver():
    """Fresh browser, never logged in — use for auth-flow tests."""
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
    """Clears cache/localStorage (not cookies) between tests on shared session drivers."""
    yield
    for name in ('admin_driver', 'user_driver'):
        d = request.node.funcargs.get(name)
        if d is not None:
            clear_state(d)


@pytest.fixture(scope='session')
def shared_state():
    """Mutable dict shared across all tests in the session (e.g. a slug created in
    one test and consumed in another)."""
    return {}


@pytest.fixture(scope='function')
def api():
    """requests.Session for direct HTTP calls — seed/teardown data without the UI."""
    s = requests.Session()
    s.base_url = API_URL
    yield s
    s.close()


@pytest.fixture
def fake_user():
    """Random but realistic FR test data — avoids hardcoded fixtures colliding
    across runs or across parallel xdist workers."""
    return {
        'name':    fake.name(),
        'email':   fake.unique.email(),
        'phone':   fake.phone_number(),
        'address': fake.address(),
        'company': fake.company(),
        'message': fake.paragraph(nb_sentences=3),
    }


# ── Report enrichment ──────────────────────────────────────────────────────────
@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item, call):
    outcome = yield
    report  = outcome.get_result()

    # 'report.extra' (singular): switching to plural 'extras' silently breaks screenshot
    # embedding due to pytest-html's hookwrapper ordering (verified by hand — image
    # disappears from the JSON blob). Keep singular until pytest-html guarantees ordering.
    report.extra = getattr(report, 'extra', [])

    if report.when != 'call':
        return

    # Record outcome for flaky history (every test, regardless of pass/fail).
    flaky_mod.record(item.nodeid, report.outcome)

    # Self-heal events — attach to report so the column and detail panel show them.
    healed = self_heal.events_for(item.nodeid)
    report.healed_count = len(healed)
    if healed and extras:
        report.extra.append(extras.text(
            '\n'.join(healed),
            name='⚠ Sélecteur auto-réparé — à corriger dans pages/*.py',
        ))

    # Visual regression — runs on every test (pass or fail).
    if VISUAL_ENABLED:
        _driver = _find_driver(item)
        if _driver is not None:
            try:
                os.makedirs(SCREENSHOTS, exist_ok=True)
                diff_name = item.nodeid.replace('/', '_').replace('::', '__') + '_visualdiff.png'
                diff_path = os.path.join(SCREENSHOTS, diff_name)
                diff_pct, diff_img = check_visual_regression(_driver, item.nodeid, diff_path)
                # Sub-threshold drift (no diff_img produced): treat as 0.0 ("identique"),
                # not as "Δx%" — the threshold exists exactly to suppress this noise.
                # Keep None for first-run baseline creation (nothing to compare yet).
                if diff_pct is not None and not diff_img:
                    diff_pct = 0.0
                report.visual_diff_pct = diff_pct
                if diff_img and extras:
                    rel = os.path.relpath(diff_img, start='tests')
                    report.extra.append(extras.image(rel, name=f'Régression visuelle ({diff_pct:.1f}%)'))
            except Exception:
                pass

    if not report.failed:
        return

    # Screenshot / replay GIF — failure only.
    _driver = _find_driver(item)
    if _driver is None:
        return

    os.makedirs(SCREENSHOTS, exist_ok=True)
    slug = item.nodeid.replace('/', '_').replace('::', '__')
    png_path = os.path.join(SCREENSHOTS, f'{slug}.png')
    try:
        _driver.save_screenshot(png_path)
        media_path = png_path

        # Replay GIF: threshold >= 1 buffered frame (not >= 2) because a single
        # driver.get() + the final failure screenshot already makes a meaningful
        # before/after — requiring 2 buffered frames would silently skip all
        # SEO/a11y/perf tests that only navigate once.
        frames = replay.frames_for(item.nodeid)
        if replay.REPLAY_ENABLED and len(frames) >= 1:
            gif_path = png_path.rsplit('.', 1)[0] + '_replay.gif'
            if replay.build_gif(frames, png_path, gif_path):
                media_path = gif_path

        if extras:
            # Path must be relative to tests/report.html, not project root.
            report.extra.append(extras.image(os.path.relpath(media_path, start='tests')))
    except Exception:
        pass

    try:
        errors = [e for e in _driver.get_log('browser') if e.get('level') == 'SEVERE']
        if errors and extras:
            report.extra.append(extras.text(
                '\n'.join(str(e)[:300] for e in errors[:5]),
                name='Console errors',
            ))
    except Exception:
        pass


def _find_driver(item):
    """Returns the first active driver fixture found on the test item, or None."""
    for name in ('admin_driver', 'user_driver', 'guest_driver', 'mobile_driver'):
        d = item.funcargs.get(name)
        if d is not None:
            return d
    return None


# ── Report hooks — delegate to report/hooks.py ────────────────────────────────
def pytest_html_report_title(report):
    report.title = 'Test End-to-End — Rapport'


def pytest_html_results_summary(prefix, summary, postfix, session):
    """Injects report_theme.js — the custom dashboard that replaces pytest-html's raw table."""
    report_hooks.inject_js(postfix)


def pytest_html_results_table_header(cells):
    report_hooks.table_header(cells)


def pytest_html_results_table_row(report, cells):
    report_hooks.table_row(report, cells, flaky_info_fn=flaky_mod.info)


# ── Auto-fix hook (empty FIXES by default — see utils/auto_fix.py) ────────────
@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_call(item):
    outcome = yield
    if outcome.excinfo is None:
        return
    drivers = [d for d in (_find_driver(item),) if d]
    if not drivers or not check_and_fix(drivers):
        return
    try:
        item.runtest()
        outcome.force_result(None)
        log.warning(f"[AutoFix] '{item.name}' passed after automatic fix")
    except Exception:
        pass
