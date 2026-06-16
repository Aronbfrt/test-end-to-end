"""tests/conftest.py — constants, fixtures, report enrichment, optional auto-fix retry.
Import convention: every internal import uses the `tests.` prefix (tests/__init__.py makes
this a package; pytest adds the project root to sys.path because of that __init__.py).
"""
import io
import json
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
    from tests.utils.visual import check_visual_regression
except ImportError:
    Image = None
    check_visual_regression = None

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


from selenium.webdriver.remote.webdriver import WebDriver as _SeleniumWebDriver
from selenium.webdriver.remote.webelement import WebElement as _SeleniumWebElement

if REPLAY_ENABLED:
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


# ── Self-healing selectors — narrow and conservative on purpose. When a By.ID or By.NAME
# lookup finds nothing, try exactly ONE fallback (the same value as a different common
# attribute — id<->name<->data-testid) before giving up. No fuzzy text matching, no "closest
# element" heuristics — those guess, and a test silently interacting with the wrong element
# is worse than a clear failure. If the narrow fallback works, the healing is logged AND
# surfaced loudly in the report (never silent) so the selector actually gets fixed instead
# of quietly papering over drift forever.
SELF_HEAL_ENABLED = os.getenv('TEST_SELF_HEAL', '1') == '1'

_heal_events: dict[str, list[str]] = {}

if SELF_HEAL_ENABLED:
    from selenium.webdriver.common.by import By as _By
    from selenium.common.exceptions import NoSuchElementException as _NoSuchElementException

    _FALLBACK_STRATEGY = {
        _By.ID:   lambda v: (_By.CSS_SELECTOR, f'[name="{v}"], [data-testid="{v}"]'),
        _By.NAME: lambda v: (_By.CSS_SELECTOR, f'[id="{v}"], [data-testid="{v}"]'),
    }

    _original_driver_find = _SeleniumWebDriver.find_element
    _original_element_find = _SeleniumWebElement.find_element

    def _record_heal(by, value, fallback_desc) -> None:
        if _current_test_id is None:
            return
        msg = f'{by}="{value}" introuvable — repli {fallback_desc} a fonctionné'
        _heal_events.setdefault(_current_test_id, []).append(msg)
        log.warning(f'[SelfHeal] {msg}')

    def _attempt_heal(context, original_finder, by, value):
        builder = _FALLBACK_STRATEGY.get(by)
        if not builder or not value:
            return None
        fb_by, fb_value = builder(value)
        try:
            element = original_finder(context, fb_by, fb_value)
        except Exception:
            return None
        _record_heal(by, value, f'{fb_by}="{fb_value}"')
        return element

    def _patched_driver_find(self, by=_By.ID, value=None):
        try:
            return _original_driver_find(self, by, value)
        except _NoSuchElementException:
            healed = _attempt_heal(self, _original_driver_find, by, value)
            if healed is not None:
                return healed
            raise

    def _patched_element_find(self, by=_By.ID, value=None):
        try:
            return _original_element_find(self, by, value)
        except _NoSuchElementException:
            healed = _attempt_heal(self, _original_element_find, by, value)
            if healed is not None:
                return healed
            raise

    _SeleniumWebDriver.find_element = _patched_driver_find
    _SeleniumWebElement.find_element = _patched_element_find


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
    _heal_events.pop(item.nodeid, None)


def pytest_runtest_logfinish(nodeid, location):
    # bounds memory regardless of pass/fail — a buffer only needs to survive long enough for
    # pytest_runtest_makereport (below) to read it during the 'call' phase, which always
    # happens before this hook fires.
    _frame_buffers.pop(nodeid, None)
    _last_capture_ts.pop(nodeid, None)
    _heal_events.pop(nodeid, None)


# ── Visual regression — flags pixel drift against a stored baseline even on a passing test.
# Baselines are screen/font/OS-dependent, gitignored by default — regenerate per machine.
VISUAL_ENABLED = os.getenv('TEST_VISUAL', '1') == '1' and check_visual_regression is not None


# ── Flaky-test detection — a lightweight JSONL history of past runs' outcomes per test.
# A test that flips between Passed/Failed across recent runs without any code change is a
# stability problem worth surfacing on its own, separate from "is it red right now". Most
# pytest+Selenium setups just retry and throw the signal away (pytest-rerunfailures masks
# it); this keeps it visible instead.
HISTORY_PATH     = os.getenv('TEST_HISTORY_FILE', 'tests/.test-history.jsonl')
HISTORY_MAX_RUNS = int(os.getenv('TEST_HISTORY_MAX_RUNS', '20'))
FLAKY_ENABLED    = os.getenv('TEST_FLAKY_DETECTION', '1') == '1'

_history_runs: list[dict] = []
_session_results: dict[str, str] = {}


def _load_history() -> None:
    global _history_runs
    if not FLAKY_ENABLED or not os.path.exists(HISTORY_PATH):
        return
    try:
        with open(HISTORY_PATH, encoding='utf-8') as f:
            lines = f.readlines()[-HISTORY_MAX_RUNS:]
        _history_runs = [json.loads(line) for line in lines if line.strip()]
    except Exception:
        _history_runs = []


def _flaky_info(test_id: str) -> tuple[int, int] | None:
    """Returns (n_distinct_outcomes, n_runs_seen) across recent history, excluding the
    current run. None if this test has no history yet."""
    outcomes = [run['results'][test_id] for run in _history_runs if test_id in run.get('results', {})]
    if not outcomes:
        return None
    return len(set(outcomes)), len(outcomes)


def _save_history() -> None:
    if not FLAKY_ENABLED or not _session_results:
        return
    try:
        os.makedirs(os.path.dirname(HISTORY_PATH) or '.', exist_ok=True)
        existing = []
        if os.path.exists(HISTORY_PATH):
            with open(HISTORY_PATH, encoding='utf-8') as f:
                existing = f.readlines()
        record = json.dumps({'timestamp': time.time(), 'results': _session_results})
        kept = existing[-(HISTORY_MAX_RUNS - 1):] if HISTORY_MAX_RUNS > 1 else []
        with open(HISTORY_PATH, 'w', encoding='utf-8') as f:
            f.writelines(kept + [record + '\n'])
    except Exception:
        pass


# ── Same overwrite philosophy as tests/report.html: each run replaces the previous one,
# nothing accumulates run after run. Wipe screenshots from the last run before this one starts
# (skip under xdist workers — only the master process should do it, or workers would race
# each other and delete screenshots a sibling worker just wrote).
def pytest_sessionstart(session):
    _load_history()  # safe to do per-worker too — read-only, no race
    if hasattr(session.config, 'workerinput'):
        return
    shutil.rmtree(SCREENSHOTS, ignore_errors=True)


def pytest_sessionfinish(session, exitstatus):
    # Under xdist (-n auto), each worker runs a disjoint subset of tests in its own process —
    # the master never sees individual results, and workers writing concurrently to the same
    # file would race. Simplest safe choice: flaky history only accumulates on a plain
    # sequential run (no -n). Known limitation, not a silent bug — visual regression and the
    # replay GIF aren't affected, this only concerns the cross-run stability signal.
    if hasattr(session.config, 'workerinput'):
        return
    _save_history()


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

    if report.when != 'call':
        return

    # Track this run's outcome for the flaky-history file, and run the visual-regression
    # check — both happen on every test regardless of pass/fail, unlike the failure-only
    # screenshot/replay logic below.
    _session_results[item.nodeid] = report.outcome

    healed = _heal_events.get(item.nodeid)
    report.healed_count = len(healed) if healed else 0
    if healed and extras:
        report.extra.append(extras.text(
            '\n'.join(healed),
            name='⚠ Sélecteur auto-réparé — à corriger dans pages/*.py',
        ))

    if VISUAL_ENABLED:
        driver_for_visual = next(
            (item.funcargs.get(n) for n in ('admin_driver', 'user_driver', 'guest_driver', 'mobile_driver')
             if item.funcargs.get(n) is not None),
            None,
        )
        if driver_for_visual is not None:
            try:
                os.makedirs(SCREENSHOTS, exist_ok=True)
                diff_name = item.nodeid.replace('/', '_').replace('::', '__') + '_visualdiff.png'
                diff_path = os.path.join(SCREENSHOTS, diff_name)
                diff_pct, diff_img = check_visual_regression(driver_for_visual, item.nodeid, diff_path)
                report.visual_diff_pct = diff_pct
                if diff_img and extras:
                    rel = os.path.relpath(diff_img, start='tests')
                    report.extra.append(extras.image(rel, name=f'Régression visuelle ({diff_pct:.1f}% des pixels)'))
            except Exception:
                pass

    if not report.failed:
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


# ── Category / Visual / Stability columns — visible at a glance, no need to open each row ──
CATEGORY_MARKERS = ['security', 'seo', 'a11y', 'responsive', 'performance', 'admin', 'stripe', 'smoke']


def pytest_html_results_table_header(cells):
    cells.insert(2, '<th>Category</th>')
    cells.insert(3, '<th>Visuel</th>')
    cells.insert(4, '<th>Stabilité</th>')
    cells.insert(5, '<th>Sélecteur</th>')


def pytest_html_results_table_row(report, cells):
    cats = [m for m in CATEGORY_MARKERS if m in report.keywords]
    label = ', '.join(cats) or '-'
    css_class = ' class="cat-security"' if 'security' in cats else ''
    cells.insert(2, f'<td{css_class}>{label}</td>')

    diff_pct = getattr(report, 'visual_diff_pct', None)
    if diff_pct is None:
        visual_label = '—'
    elif diff_pct == 0.0:
        visual_label = 'identique'
    else:
        visual_label = f'Δ{diff_pct:.1f}%'
    cells.insert(3, f'<td>{visual_label}</td>')

    flaky = _flaky_info(report.nodeid) if FLAKY_ENABLED else None
    if flaky and flaky[0] > 1:
        stability_label = f'instable ({flaky[0]}/{flaky[1]})'
    elif flaky:
        stability_label = 'stable'
    else:
        stability_label = '—'
    cells.insert(4, f'<td>{stability_label}</td>')

    healed_count = getattr(report, 'healed_count', 0)
    selector_label = f'auto-réparé ×{healed_count}' if healed_count else '—'
    cells.insert(5, f'<td>{selector_label}</td>')


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
