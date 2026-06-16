"""Auto-fix engine — detects a known backend error in the page and applies a fix, then the
test gets retried once (wired in conftest.py's pytest_runtest_call hook).

Empty by default — this is a *mechanism*, not a feature. Add project-specific entries to
FIXES if there's a recurring, safely-automatable failure (e.g. a known missing DB default).
Never add a fix that mutates data destructively or runs in prod.
"""
import logging
import re

log = logging.getLogger('e2e')

# Each entry: (regex matched against the page's body text, callable(re.Match) -> None)
# Example (commented out — adapt the regex/table to the real schema before using):
#
# import subprocess
# def _fix_missing_default(m: re.Match) -> None:
#     col, table = m.group(1), m.group(2)
#     subprocess.run(['mysql', '-uroot', 'mydb', '-e',
#         f"ALTER TABLE `{table}` MODIFY COLUMN `{col}` VARCHAR(255) NOT NULL DEFAULT '';"], check=True)
#
# FIXES: list[tuple[str, callable]] = [
#     (r"Field '(\w+)' doesn't have a default value.*?insert into (\w+)", _fix_missing_default),
# ]

FIXES: list[tuple[str, callable]] = []


def get_page_text(driver) -> str:
    try:
        return driver.find_element('tag name', 'body').text
    except Exception:
        return ''


def check_and_fix(drivers: list) -> bool:
    """Inspects each driver for a known error. Applies the fix if matched.
    Returns True if a fix was applied (caller should retry the test once).
    """
    if not FIXES:
        return False
    for driver in drivers:
        if driver is None:
            continue
        text = get_page_text(driver)
        if not text:
            continue
        for pattern, fix_fn in FIXES:
            m = re.search(pattern, text, re.DOTALL | re.IGNORECASE)
            if m:
                log.warning('[AutoFix] error detected: %s', m.group(0)[:120])
                fix_fn(m)
                return True
    return False
