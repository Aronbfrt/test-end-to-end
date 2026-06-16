"""tests/conftest.py — constants, fixtures, report enrichment, optional auto-fix retry.
Import convention: every internal import uses the `tests.` prefix (tests/__init__.py makes
this a package; pytest adds the project root to sys.path because of that __init__.py).
"""
import io
import os
import shutil
import time
import logging
import collections

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

try:
    from PIL import Image
except ImportError:
    Image = None

load_dotenv('.env.test')

# ── Config ────────────────────────────────────────────────────────────────────
ADMIN_EMAIL = os.getenv('TEST_ADMIN_EMAIL', 'admin@example.com')
ADMIN_PASS  = os.getenv('TEST_ADMIN_PASS',  'password')
USER_EMAIL  = os.getenv('TEST_USER_EMAIL',  'user@example.com')
USER_PASS   = os.getenv('TEST_USER_PASS',   'password')
API_URL     = os.getenv('TEST_API_URL', helpers_module.BASE_URL)
SCREENSHOTS = os.getenv('TEST_SCREENSHOTS', 'tests/screenshots')
ADMIN_DASHBOARD_PATH = os.getenv('TEST_ADMIN_DASHBOARD_PATH', '/admin/dashboard')

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s %(levelname)s %(message)s',
    handlers=[logging.FileHandler('tests/tests.log'), logging.StreamHandler()],
)
log = logging.getLogger('e2e')

fake = Faker('fr_FR')   # adapt locale per project


# ── Failure replay — instead of a single screenshot at the moment of failure, capture a
# rolling filmstrip of the last few navigations/clicks and assemble it into an animated GIF
# when a test fails. The report then shows what the bot actually did right up to the crash,
# not just where it ended up. Off by default cost is near zero for passing tests (a capped
# in-memory deque, cleared the instant the test finishes); set TEST_REPLAY=0 to disable
# entirely if click/navigation overhead ever matters more than this.
REPLAY_ENABLED   = os.getenv('TEST_REPLAY', '1') == '1' and Image is not None
REPLAY_MAX_FRAMES = 8
REPLAY_MIN_INTERVAL_S = 0.25  # don't flood the buffer on tight loops (e.g. SQLi probes)

_current_test_id: str | None = None
_frame_buffers: dict[str, collections.deque] = {}
_last_capture_ts: dict[str, float] = {}


def _capture_frame(driver) -> None:
    if not REPLAY_ENABLED or _current_test_id is None:
        return
    now = time.monotonic()
    if now - _last_capture_ts.get(_current_test_id, 0.0) < REPLAY_MIN_INTERVAL_S:
        return
    try:
        png = driver.get_screenshot_as_png()
    except Exception:
        return
    _last_capture_ts[_current_test_id] = now
    _frame_buffers.setdefault(_current_test_id, collections.deque(maxlen=REPLAY_MAX_FRAMES)).append(png)


if REPLAY_ENABLED:
    from selenium.webdriver.remote.webdriver import WebDriver as _SeleniumWebDriver
    from selenium.webdriver.remote.webelement import WebElement as _SeleniumWebElement

    _original_get = _SeleniumWebDriver.get
    _original_click = _SeleniumWebElement.click

    def _patched_get(self, url_):  # noqa: ANN001 — mirrors Selenium's own signature
        result = _original_get(self, url_)
        _capture_frame(self)
        return result

    def _patched_click(self):
        result = _original_click(self)
        try:
            _capture_frame(self._parent)
        except Exception:
            pass
        return result

    _SeleniumWebDriver.get = _patched_get
    _SeleniumWebElement.click = _patched_click


def _build_replay_gif(frames: list[bytes], final_png_path: str, out_path: str) -> bool:
    """Assembles captured frames + the final failure screenshot into one animated GIF.
    Returns True on success — caller falls back to the plain static screenshot on False.

    Many tests just navigate once and assert on something that doesn't change the page
    visually (a missing meta tag, a missing header) — the captured frame and the final
    screenshot end up pixel-identical. A "replay" with no actual movement is worse than no
    replay at all (PIL even collapses truly identical consecutive frames down to one on
    save, silently producing a single-frame "GIF" that looks like nothing happened). Drop
    consecutive duplicates by raw bytes before saving, and bail out to the plain screenshot
    if fewer than 2 distinct frames remain — no point animating a still image.
    """
    try:
        with open(final_png_path, 'rb') as f:
            raw_frames = [*frames, f.read()]
        deduped = [raw_frames[0]]
        for b in raw_frames[1:]:
            if b != deduped[-1]:
                deduped.append(b)
        if len(deduped) < 2:
            return False

        images = [Image.open(io.BytesIO(b)).convert('RGB') for b in deduped]
        w, h = images[0].size
        scale = min(1.0, 480 / w)
        if scale < 1.0:
            images = [im.resize((int(w * scale), int(h * scale))) for im in images]
        images[0].save(out_path, save_all=True, append_images=images[1:], duration=550, loop=0, optimize=True)
        return True
    except Exception:
        return False


def pytest_runtest_setup(item):
    global _current_test_id
    _current_test_id = item.nodeid
    _frame_buffers.pop(item.nodeid, None)
    _last_capture_ts.pop(item.nodeid, None)


def pytest_runtest_logfinish(nodeid, location):
    # bounds memory regardless of pass/fail — a buffer only needs to survive long enough for
    # pytest_runtest_makereport (below) to read it during the 'call' phase, which always
    # happens before this hook fires.
    _frame_buffers.pop(nodeid, None)
    _last_capture_ts.pop(nodeid, None)


# ── Same overwrite philosophy as tests/report.html: each run replaces the previous one,
# nothing accumulates run after run. Wipe screenshots from the last run before this one starts
# (skip under xdist workers — only the master process should do it, or workers would race
# each other and delete screenshots a sibling worker just wrote).
def pytest_sessionstart(session):
    if hasattr(session.config, 'workerinput'):
        return
    shutil.rmtree(SCREENSHOTS, ignore_errors=True)


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
    # 'report.extra' (singular) triggers a pytest-html deprecation warning ("use
    # report.extras instead"), but switching to 'extras' actually breaks the screenshot
    # embed — pytest-html's own makereport hookimpl reassigns report.extras from a
    # combined list before reading ours back, depending on hookwrapper ordering, and the
    # image silently disappears from the report's data-jsonblob. Verified by hand: 'extra'
    # embeds correctly every time, 'extras' lost the screenshot in testing. Keep 'extra'
    # until pytest-html's own ordering guarantees make 'extras' safe to switch to.
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

    os.makedirs(SCREENSHOTS, exist_ok=True)
    name = item.nodeid.replace('/', '_').replace('::', '__')
    path = os.path.join(SCREENSHOTS, f'{name}.png')
    try:
        driver.save_screenshot(path)
        media_path = path

        # Replay GIF — the captured filmstrip (if any) plus this final frame, shown instead
        # of the single static screenshot. Falls back to the plain screenshot if there
        # weren't enough frames buffered or Pillow isn't installed.
        #
        # Threshold is >=1, not >=2: most generated tests are a single driver.get() followed
        # by an assertion (SEO/a11y/perf checks never click anything) — that one captured
        # frame plus the final failure screenshot already makes a meaningful 2-image
        # before/after GIF. Requiring 2 buffered frames meant almost none of those tests
        # ever got a replay at all, only multi-step flows (auth, checkout, forms) did.
        frames = list(_frame_buffers.get(item.nodeid, ()))
        if REPLAY_ENABLED and len(frames) >= 1:
            gif_path = path.rsplit('.', 1)[0] + '_replay.gif'
            if _build_replay_gif(frames, path, gif_path):
                media_path = gif_path

        if extras:
            # pytest-html uses this path AS-IS as the <img src>, resolved relative to
            # report.html's own location (tests/report.html) — not relative to CWD (project
            # root, where pytest actually runs from). Without this rebase the path keeps its
            # "tests/" prefix and the browser looks for tests/tests/screenshots/... (404,
            # broken image icon). Rebase it relative to the tests/ dir specifically.
            report_relative_path = os.path.relpath(media_path, start='tests')
            report.extra.append(extras.image(report_relative_path))
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


def pytest_html_results_summary(prefix, summary, postfix, session):
    """Injects report_theme.js — a full custom dashboard rendered from pytest-html's own
    data-jsonblob (the only supported injection point for raw HTML/script; pytest-html
    rebuilds #results-table from scratch on every filter/sort, so DOM patches on it don't
    survive — reading the same JSON and rendering our own view sidesteps that entirely)."""
    js_path = os.path.join(os.path.dirname(__file__), 'report_theme.js')
    try:
        with open(js_path, encoding='utf-8') as f:
            postfix.append(f'<script>{f.read()}</script>')
    except OSError:
        pass


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
