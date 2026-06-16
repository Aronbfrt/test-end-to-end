"""Visual regression — compares each test's screenshot to a stored baseline and flags
pixel drift even when the test's own assertions pass. A test can be functionally green and
still mean "the button moved" or "the header is now invisible" — this catches that class of
bug that no assertion ever checks for.

First run for a given test creates its baseline (nothing to compare against yet). Baselines
are screen/font/OS-dependent — gitignored by default (see gitignore-snippet.txt), regenerate
per machine/CI runner rather than committing them.
"""
import hashlib
import io
import os

from PIL import Image, ImageChops

BASELINE_DIR = os.getenv('TEST_VISUAL_BASELINES', 'tests/.visual-baselines')
DIFF_THRESHOLD_PCT = float(os.getenv('TEST_VISUAL_THRESHOLD', '1.0'))  # % of pixels, ignoring AA noise


def _baseline_path(test_id: str) -> str:
    digest = hashlib.sha1(test_id.encode()).hexdigest()[:16]
    return os.path.join(BASELINE_DIR, f'{digest}.png')


def check_visual_regression(driver, test_id: str, out_diff_path: str) -> tuple[float | None, str | None]:
    """Returns (diff_pct, diff_image_path).

    diff_pct is None the first time a test is seen (baseline just created — nothing to
    report yet). diff_image_path is only set when diff_pct exceeds DIFF_THRESHOLD_PCT —
    a red-highlighted overlay showing exactly what changed.
    """
    os.makedirs(BASELINE_DIR, exist_ok=True)
    baseline_path = _baseline_path(test_id)
    current = Image.open(io.BytesIO(driver.get_screenshot_as_png())).convert('RGB')

    if not os.path.exists(baseline_path):
        current.save(baseline_path)
        return None, None

    baseline = Image.open(baseline_path).convert('RGB')
    if baseline.size != current.size:
        current = current.resize(baseline.size)

    diff = ImageChops.difference(baseline, current)
    if diff.getbbox() is None:
        return 0.0, None

    # % of pixels with a meaningful difference — ignore near-zero noise from anti-aliasing/
    # font hinting, which would otherwise flag every single run as "changed".
    diff_l = diff.convert('L')
    histogram = diff_l.histogram()
    significant = sum(histogram[30:])
    total = current.size[0] * current.size[1]
    pct = 100.0 * significant / total

    if pct <= DIFF_THRESHOLD_PCT:
        return pct, None

    mask = diff_l.point(lambda p: 255 if p > 30 else 0)
    red_layer = Image.new('RGB', current.size, (255, 0, 0))
    overlay = current.copy()
    overlay.paste(red_layer, mask=mask)
    blended = Image.blend(current, overlay, 0.45)
    blended.save(out_diff_path)
    return pct, out_diff_path


def reset_baseline(test_id: str) -> bool:
    """Deletes a test's baseline so the next run recreates it — use after an intentional
    UI change to stop it from being flagged as a regression forever."""
    path = _baseline_path(test_id)
    if os.path.exists(path):
        os.remove(path)
        return True
    return False
