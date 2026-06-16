"""Reusable quality-gate assertions — call from any domain test file.
Keeps a11y/perf/responsive logic in one place instead of duplicated per page.
"""
from selenium.webdriver.common.by import By

BLOCKING_IMPACTS = {'critical', 'serious'}
LOAD_TIME_BUDGET_MS = 4000
MAX_IMAGE_BYTES = 500_000  # 500KB


def check_accessibility(driver, blocking_impacts: set | None = None) -> None:
    """Scan axe-core sur la page courante. Échoue seulement sur violations critical/serious."""
    from axe_selenium_python import Axe
    axe = Axe(driver)
    axe.inject()
    results = axe.run()
    blocking = [v for v in results['violations'] if v['impact'] in (blocking_impacts or BLOCKING_IMPACTS)]
    assert not blocking, '; '.join(f"{v['id']}: {v['help']}" for v in blocking)


def check_no_horizontal_overflow(driver, label: str = '') -> None:
    scroll_width = driver.execute_script('return document.documentElement.scrollWidth')
    client_width = driver.execute_script('return document.documentElement.clientWidth')
    assert scroll_width <= client_width + 1, \
        f'{label} : débordement horizontal ({scroll_width}px de contenu dans un viewport de {client_width}px)'


def check_load_budget(driver, budget_ms: int = LOAD_TIME_BUDGET_MS) -> None:
    load_ms = driver.execute_script("const t = performance.timing; return t.loadEventEnd - t.navigationStart;")
    assert load_ms < budget_ms, f'temps de chargement {load_ms}ms dépasse le budget de {budget_ms}ms'


def check_no_console_errors(driver, allow: list[str] | None = None) -> None:
    allow = allow or []
    errors = [e for e in driver.get_log('browser') if e.get('level') == 'SEVERE']
    errors = [e for e in errors if not any(a in e.get('message', '') for a in allow)]
    assert not errors, f'erreurs console : {errors}'


def check_no_oversized_images(driver, max_bytes: int = MAX_IMAGE_BYTES) -> None:
    entries = driver.execute_script("""
        return performance.getEntriesByType('resource')
            .filter(e => e.initiatorType === 'img')
            .map(e => ({name: e.name, size: e.transferSize}));
    """)
    offenders = [e for e in entries if e['size'] > max_bytes]
    assert not offenders, 'images surdimensionnées (>{}Ko) : {}'.format(
        max_bytes // 1024, ', '.join(f"{o['name']} ({o['size'] // 1024}Ko)" for o in offenders)
    )


def check_csrf_token(driver) -> None:
    els = driver.find_elements(By.CSS_SELECTOR, 'input[name=csrf_token], input[name=_token]')
    assert els, 'token CSRF absent du formulaire'


def check_required_fields(driver, fields: list[str]) -> None:
    for field in fields:
        assert driver.find_element(By.NAME, field), f'champ requis "{field}" introuvable'
