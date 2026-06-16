# E2E test suite — pytest + Selenium, demon-slayer structure, scales to 1000+ tests

## Structure

```
project-root/
├── pytest.ini                # copied from tests/pytest.ini.project-root — MUST be at root
├── .env.test                 # copied from tests/.env.test.example, gitignored
└── tests/
    ├── __init__.py            # makes `tests` a package — required for `from tests.x import y`
    ├── conftest.py             # constants, fixtures, report enrichment, auto-fix hook wiring
    ├── bootstrap.py            # auto-installs missing deps, then runs pytest
    ├── run.sh                  # ./tests/run.sh — thin wrapper around bootstrap.py
    ├── requirements.txt
    ├── report-style.css        # dark, color-coded pytest-html theme
    ├── utils/
    │   ├── browser.py          # make_driver() — Selenium Manager auto-downloads the right driver
    │   ├── helpers.py           # url(), fill(), click_submit(), wait_for_locator(), login()...
    │   ├── checks.py             # check_accessibility, check_load_budget, check_no_console_errors...
    │   ├── seo_checks.py          # check_title_tag, check_meta_description, check_structured_data...
    │   ├── security_checks.py     # check_no_sql_error_leak, check_reflected_input_escaped, check_security_headers...
    │   ├── crud_base.py          # generic admin CRUD test base — subclass per entity
    │   ├── stripe_helper.py      # test cards, iframe filling, optional Stripe CLI listener
    │   └── auto_fix.py           # empty FIXES=[] mechanism — fill in only if truly needed
    ├── pages/                  # Page Object Model — selectors only, no assertions
    │   ├── auth_pages.py
    │   ├── admin_pages.py
    │   ├── public_pages.py
    │   └── checkout_pages.py
    └── <domain>/               # one flat folder per feature — mirrors the real product domains
        ├── home/test_home.py
        ├── public/test_public.py
        ├── auth/test_auth.py
        ├── contact/test_contact.py
        ├── admin/test_admin.py
        ├── admin_clients/test_admin_clients.py   # copy per entity
        ├── checkout/test_checkout.py
        ├── seo/test_seo.py                          # title/meta/canonical/h1/alt/structured data
        ├── security/test_security.py                # headers, sensitive paths, debug exposure, auth bypass
        ├── accessibility/test_accessibility.py    # sweep for routes without their own a11y test
        ├── responsive/test_responsive.py            # sitewide breakpoint/mobile-nav checks
        └── performance/test_performance.py
```

Run `/e2e-audit` instead of `/e2e-init` to skip all manual adaptation — it discovers routes/forms/entities from the code itself (static analysis, no live crawling) and fills every placeholder automatically, including generating one `security/test_security_<form>.py` per discovered form with non-destructive SQLi/XSS probes.

**Rule**: a domain folder owns everything about that feature — functional tests AND, where it makes sense, its own a11y/perf/responsive checks (calling `utils/checks.py`). Selectors never live inline in a test — they live in `pages/`.

## Setup — zero manual install

```bash
./tests/run.sh -m smoke -v
```

`bootstrap.py` checks for selenium/pytest/faker/etc., pip-installs whatever's missing, warns (with install commands) if no Chrome/Chromium binary is found, then runs pytest. Nothing to install by hand beyond Python 3.10+ and a browser.

Manual setup (equivalent):
```bash
pip install -r tests/requirements.txt
cp tests/.env.test.example .env.test
cp tests/pytest.ini.project-root pytest.ini
```

## Run

```bash
./tests/run.sh                          # full suite
./tests/run.sh -m smoke                 # critical path only (fast, every push)
./tests/run.sh -m regression            # full regression (before release)
./tests/run.sh -m "not slow"
./tests/run.sh -m admin
./tests/run.sh -m stripe
./tests/run.sh -m a11y
./tests/run.sh -m responsive
./tests/run.sh -m performance
./tests/run.sh tests/contact -v         # one domain folder
./tests/run.sh -n auto --dist=loadscope # parallel — see "Scaling to 1000+ tests" below
./tests/run.sh --env=staging            # hits TEST_BASE_URL_STAGING
TEST_HEADLESS=0 ./tests/run.sh          # visible browser (debug)
```

Report: `tests/report.html` (self-contained, dark themed via `report-style.css`). Every failure embeds its screenshot + last console errors **directly in the report row** — no separate folder to dig through. A **Category** column (security/seo/a11y/responsive/performance/admin/stripe/smoke) makes it obvious at a glance what kind of issue failed — security rows get a red 🔒 badge. Every assertion message in `utils/security_checks.py` and `utils/seo_checks.py` explains **what's wrong, why it matters, and how to fix it** — not just "assert failed". Every `pytest.skip()` in this template carries an explicit reason, shown in the report, so a skip never looks like a silent gap. JUnit XML at `tests/junit.xml` for CI.

## Scaling to 1000+ tests

- **Session-scoped browsers**: `admin_driver` / `user_driver` are one browser for the *entire run*, not one per test. Login happens once (lazily), persists via cookies. `clear_browser_cache` (autouse) wipes cache/localStorage between tests without logging out — keeps memory flat over hundreds of tests.
- **`guest_driver` / `mobile_driver`** stay function-scoped — only the auth-flow domain and mobile-only checks need a guaranteed-fresh browser.
- **Parallelize with `pytest-xdist`**: `-n auto --dist=loadscope` — `loadscope` keeps all tests of a module/class on the same worker, so the session-scoped driver inside that worker stays consistent. Plain `-n auto` would split a class across workers and break the shared login state.
- **One automatic rerun** on failure (`pytest-rerunfailures`) absorbs network flakiness without manual retries.
- **Markers** (`smoke`, `regression`, `admin`, `stripe`...) let CI run a 30-second smoke pass on every PR and the full 1000-test regression only on `main` or nightly.

## Fixtures (conftest.py)

| Fixture | Scope | Use |
|---|---|---|
| `admin_driver` | session | shared browser, logs in lazily on first use |
| `user_driver` | session | shared browser, login state controlled by the test |
| `guest_driver` | function | always fresh, never logged in — auth-flow tests |
| `mobile_driver` | function | fresh, mobile viewport emulation |
| `api` | function | `requests.Session` — seed/clean data without the UI |
| `fake_user` | function | Faker (FR) — name/email/phone/address, collision-free across parallel workers |
| `shared_state` | session | mutable dict shared across the whole run |

## Adding a new domain

```bash
mkdir tests/<feature>
touch tests/<feature>/__init__.py
```
Write `test_<feature>.py`, `class Test<Feature>:` with numbered `test_01_...` methods. Selectors go in a new or existing `pages/<feature>_pages.py` class. Need a11y/perf/responsive on it too? Import the relevant `check_*` from `utils/checks.py`.

## Adding a new entity's CRUD tests

```bash
mkdir tests/admin_<entity>
touch tests/admin_<entity>/__init__.py
```
Copy `tests/admin_clients/test_admin_clients.py`, rename the class, set `RESOURCE`/`CREATE_PATH`/`LIST_PATH`/`REQUIRED_FIELDS`.

## Auto-fix hook

`utils/auto_fix.py` ships with an empty `FIXES = []`. It's a *mechanism* (detect a known error string in the page → run a fix → retry the test once), not a feature you need to use. Only fill it in for a genuinely recurring, safely-automatable failure — never for anything destructive or prod-facing.

## CI

Copy `ci-e2e-tests.yml` to `.github/workflows/e2e-tests.yml`, adapt the "Start app" step to the project's boot command.

## gitignore

Append `gitignore-snippet.txt` to the project's `.gitignore` (done automatically by `/e2e-init`).
