"""Self-healing selectors — when a By.ID or By.NAME lookup finds nothing, tries exactly
ONE fallback (same value as a different common attribute: id ↔ name ↔ data-testid)
before re-raising the original NoSuchElementException.

Conservative by design:
  • No fuzzy text matching — could silently interact with the wrong element.
  • No "closest element" heuristics — same risk.
  • One-to-one attribute substitution only (the value stays identical).
  • Never silent: every heal is logged as WARNING and recorded for the report.

A heal patches the symptom for this run. The underlying selector in pages/*.py still
needs the real fix — the 🩹 chip in the report is the reminder.

Activated by conftest.py (install()) when TEST_SELF_HEAL != 0.
"""
import logging

log = logging.getLogger('e2e')

_current_test_id: str | None = None
_heal_events: dict[str, list[str]] = {}


def set_current(test_id: str | None) -> None:
    """Called by conftest.pytest_runtest_setup."""
    global _current_test_id
    _current_test_id = test_id


def clear(test_id: str) -> None:
    """Called by conftest on setup (fresh state) and logfinish (free memory)."""
    _heal_events.pop(test_id, None)


def events_for(test_id: str) -> list[str]:
    """Returns heal log lines for conftest to attach to the report."""
    return _heal_events.get(test_id, [])


def _record(by: str, value: str, fallback_desc: str) -> None:
    if _current_test_id is None:
        return
    msg = f'{by}="{value}" introuvable — repli {fallback_desc} a fonctionné'
    _heal_events.setdefault(_current_test_id, []).append(msg)
    log.warning(f'[SelfHeal] {msg}')


def install() -> None:
    """Monkeypatches find_element on WebDriver and WebElement.
    Called once at import time from conftest.py when SELF_HEAL_ENABLED is True.
    """
    from selenium.webdriver.common.by import By
    from selenium.common.exceptions import NoSuchElementException
    from selenium.webdriver.remote.webdriver import WebDriver
    from selenium.webdriver.remote.webelement import WebElement

    # One fallback per strategy — same value, different attribute.
    FALLBACK = {
        By.ID:   lambda v: (By.CSS_SELECTOR, f'[name="{v}"], [data-testid="{v}"]'),
        By.NAME: lambda v: (By.CSS_SELECTOR, f'[id="{v}"], [data-testid="{v}"]'),
    }

    _orig_driver_find   = WebDriver.find_element
    _orig_element_find  = WebElement.find_element

    def _try_heal(context, orig_finder, by, value):
        builder = FALLBACK.get(by)
        if not builder or not value:
            return None
        fb_by, fb_val = builder(value)
        try:
            el = orig_finder(context, fb_by, fb_val)
        except Exception:
            return None
        _record(by, value, f'{fb_by}="{fb_val}"')
        return el

    def _patched_driver_find(self, by=By.ID, value=None):
        try:
            return _orig_driver_find(self, by, value)
        except NoSuchElementException:
            healed = _try_heal(self, _orig_driver_find, by, value)
            if healed is not None:
                return healed
            raise

    def _patched_element_find(self, by=By.ID, value=None):
        try:
            return _orig_element_find(self, by, value)
        except NoSuchElementException:
            healed = _try_heal(self, _orig_element_find, by, value)
            if healed is not None:
                return healed
            raise

    WebDriver.find_element  = _patched_driver_find
    WebElement.find_element = _patched_element_find
