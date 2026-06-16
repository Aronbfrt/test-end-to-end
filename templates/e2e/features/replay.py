"""Failure replay — captures a rolling filmstrip of navigations/clicks during each test
and assembles them into an animated GIF when that test fails.

Why: most test reports show ONE screenshot at the moment of failure — the result, not
the story. This shows the story: what the bot actually did right up to the crash.

Activated by conftest.py (install()) when PIL is available and TEST_REPLAY != 0.
Disabled at runtime by setting REPLAY_ENABLED = False before install() is called.
"""
import collections
import io
import time

# Set by conftest.py based on env var + PIL availability — do not change here.
REPLAY_ENABLED = False

MAX_FRAMES = 8
MIN_INTERVAL_S = 0.25  # throttle: skip capture if last one was less than this ago

_current_test_id: str | None = None
_frame_buffers: dict[str, collections.deque] = {}
_last_capture_ts: dict[str, float] = {}


def set_current(test_id: str | None) -> None:
    """Called by conftest.pytest_runtest_setup to track which test is running."""
    global _current_test_id
    _current_test_id = test_id


def clear(test_id: str) -> None:
    """Called by conftest on setup (fresh start) and logfinish (free memory)."""
    _frame_buffers.pop(test_id, None)
    _last_capture_ts.pop(test_id, None)


def frames_for(test_id: str) -> list[bytes]:
    """Returns buffered PNG frames for the given test (may be empty)."""
    return list(_frame_buffers.get(test_id, ()))


def capture(driver) -> None:
    """Takes a screenshot and appends it to the current test's buffer.
    No-op if replay is disabled, no test is active, or throttle window hasn't elapsed.
    """
    if not REPLAY_ENABLED or _current_test_id is None:
        return
    now = time.monotonic()
    if now - _last_capture_ts.get(_current_test_id, 0.0) < MIN_INTERVAL_S:
        return
    try:
        png = driver.get_screenshot_as_png()
    except Exception:
        return
    _last_capture_ts[_current_test_id] = now
    _frame_buffers.setdefault(_current_test_id, collections.deque(maxlen=MAX_FRAMES)).append(png)


def build_gif(frames: list[bytes], final_png_path: str, out_path: str) -> bool:
    """Assembles captured frames + the final failure screenshot into one animated GIF.
    Returns True on success — conftest falls back to the plain static screenshot on False.

    Bails out early (returns False) when frames are pixel-identical after deduplication:
    PIL silently collapses identical consecutive GIF frames down to one, producing a
    "1-frame GIF" that looks like nothing happened — worse than the plain screenshot.
    """
    from PIL import Image
    try:
        with open(final_png_path, 'rb') as f:
            raw = [*frames, f.read()]
        # byte-level dedup — consecutive identical frames carry no information
        deduped = [raw[0]]
        for b in raw[1:]:
            if b != deduped[-1]:
                deduped.append(b)
        if len(deduped) < 2:
            return False
        images = [Image.open(io.BytesIO(b)).convert('RGB') for b in deduped]
        w, h = images[0].size
        scale = min(1.0, 480 / w)
        if scale < 1.0:
            images = [im.resize((int(w * scale), int(h * scale))) for im in images]
        images[0].save(out_path, save_all=True, append_images=images[1:],
                       duration=550, loop=0, optimize=True)
        return True
    except Exception:
        return False


def install() -> None:
    """Monkeypatches WebDriver.get and WebElement.click to capture frames silently.
    Called once at import time from conftest.py when REPLAY_ENABLED is True.
    """
    from selenium.webdriver.remote.webdriver import WebDriver
    from selenium.webdriver.remote.webelement import WebElement

    _orig_get   = WebDriver.get
    _orig_click = WebElement.click

    def _patched_get(self, url_):
        result = _orig_get(self, url_)
        capture(self)
        return result

    def _patched_click(self):
        result = _orig_click(self)
        try:
            capture(self._parent)
        except Exception:
            pass
        return result

    WebDriver.get   = _patched_get
    WebElement.click = _patched_click
