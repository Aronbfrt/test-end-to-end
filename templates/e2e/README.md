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
    │   ├── checks.py             # axe-core scan + skip link/form labels/landmarks/aria-hidden traps/button names (a11y), responsive images/font size, render-blocking JS/page weight/DOM size/FCP/gzip (perf)
    │   ├── seo_checks.py          # title/meta/canonical+https/h1/heading hierarchy/alt/lang/viewport/OG/noindex/structured data/robots/sitemap
    │   ├── security_checks.py     # SQLi leak/XSS reflection/headers/HSTS/cookies/server version/open redirect/dir listing/CORS/sensitive paths/debug banner/admin bypass
    │   ├── visual.py               # check_visual_regression — pixel diff against a stored baseline
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

Report: `tests/report.html` (self-contained, dark themed via `report-style.css`). Every failure embeds its screenshot + last console errors **directly in the report row** — no separate folder to dig through, click a screenshot to see it full size. A **Category** column (security/seo/a11y/responsive/performance/admin/stripe/smoke) makes it obvious at a glance what kind of issue failed — security rows get a red 🔒 badge. Every assertion message in `utils/security_checks.py` and `utils/seo_checks.py` explains **what's wrong, why it matters, and how to fix it** — not just "assert failed". Every `pytest.skip()` in this template carries an explicit reason, shown in the report, so a skip never looks like a silent gap. JUnit XML at `tests/junit.xml` for CI.

### Actually re-running a test from the report ("Relancer")

Double-clicking `tests/report.html` opens a plain `file://` page — no backend, so the rerun button there can only copy the pytest command to your clipboard (still genuinely useful, just not a real execution).

For a button that **actually re-runs the test**, serve the report through the included tiny local server instead of opening the file directly:

```bash
python3 tests/live_server.py            # http://localhost:8765/tests/report.html
```

Open that URL (not the file) — the same button now POSTs to `/__rerun__`, the server runs `pytest <that one test>` for real, and the row updates in place (icon, log, stat cards) with the actual new result. No server running → same button silently falls back to the clipboard-copy behavior, no error shown.

### Failure replay — not a screenshot, a clip of what actually happened

Most reports show one screenshot at the moment of failure — the *result*, not the *story*. This one shows the story: every `driver.get()` and every `.click()` is silently snapshotted (capped at 8 frames, throttled to avoid flooding on tight loops), and on failure those frames get assembled into a small animated GIF — the bot's last few moves leading up to the crash, autoplaying right in the row (🎬 *replay des dernières actions* badge). Click it to see it full size in the lightbox.

Needs Pillow (already in `requirements.txt`). Disable with `TEST_REPLAY=0` in `.env.test` if the extra screenshot calls ever matter more than this for a very latency-sensitive suite — falls back to the old single static screenshot.

### Visual regression — catches what no assertion ever checks for

Every test gets compared to a stored baseline screenshot, pass or fail. A test can be 100% functionally green and still mean the button moved, the header turned invisible, or a CSS regression broke the layout — none of that shows up in an `assert`. This does: a `👁 ΔX%` chip appears on the row, and a `👁 N régressions visuelles` alert in the hero, the moment pixel drift crosses the threshold.

First run for a given test creates its baseline (nothing to compare yet). Baselines live in `tests/.visual-baselines/`, gitignored by default — they're screen/font/OS-dependent, so commit-and-share isn't reliable across machines; regenerate per environment. After an intentional UI change, delete the test's baseline (or the whole folder) so it stops being flagged forever. Tune sensitivity with `TEST_VISUAL_THRESHOLD` (% of differing pixels, default 1.0) or disable with `TEST_VISUAL=0`.

### Flaky-test detection — the signal pytest-rerunfailures normally throws away

A test that needs a retry to pass is telling you something: it's not reliable, even though the report shows green at the end. Most setups discard that signal entirely. This keeps a lightweight history (`tests/.test-history.jsonl`, last 20 runs by default) of every test's outcome, and flags `🎲 instable (2/3)` the moment a test has disagreed with itself across recent runs — separate from "is it red right now".

Sequential runs only — under `pytest-xdist` (`-n auto`) each worker only sees its own subset of tests and writing history concurrently would race, so history accumulation is skipped there (documented limitation, not a silent bug). Tune with `TEST_HISTORY_MAX_RUNS` or disable with `TEST_FLAKY_DETECTION=0`.

### Self-healing selectors — narrow on purpose, never silent

When a `By.ID` or `By.NAME` lookup finds nothing, one fallback is tried — the same value as the other common attribute (id↔name↔data-testid) — before giving up. No fuzzy text matching, no "closest element" guessing: those approaches can silently interact with the wrong element, which is worse than a clean failure. If the narrow fallback works, the test continues, but the healing is never quiet about it — a `🩹 auto-réparé ×N` chip on the row, a `🩹 N sélecteur(s) auto-réparé(s)` alert in the hero, the exact original/fallback locators logged and attached to the report. It papers over the symptom for this run; the selector in `pages/*.py` still needs the real fix.

Disable with `TEST_SELF_HEAL=0` if a drifted selector should hard-fail instead of healing — useful right after a deliberate markup change, when you want to know about every affected test rather than have them quietly keep passing.

## Scaling to 1000+ tests

- **Session-scoped browsers**: `admin_driver` / `user_driver` are one browser for the *entire run*, not one per test. Login happens once (lazily), persists via cookies. `clear_browser_cache` (autouse) wipes cache/localStorage between tests without logging out — keeps memory flat over hundreds of tests.
- **`guest_driver` / `mobile_driver`** stay function-scoped — only the auth-flow domain and mobile-only checks need a guaranteed-fresh browser.
- **Parallelize with `pytest-xdist`**: `-n auto --dist=loadscope` — `loadscope` keeps all tests of a module/class on the same worker, so the session-scoped driver inside that worker stays consistent. Plain `-n auto` would split a class across workers and break the shared login state.
- **One automatic rerun** on failure (`pytest-rerunfailures`) absorbs network flakiness without manual retries.
- **Markers** (`smoke`, `regression`, `admin`, `stripe`...) let CI run a 30-second smoke pass on every PR and the full 1000-test regression only on `main` or nightly.

## Configuration — what to edit to control which tests run / show

Three different places, three different jobs — don't confuse them:

1. **`pytest.ini` (project root)** — *which tests exist as a category*. The `markers =` block declares `smoke`, `regression`, `admin`, `stripe`, `a11y`, `responsive`, `performance`, `seo`, `security`. Add a new marker here before using `@pytest.mark.yourmarker` in a test, or pytest warns about an unknown marker.
2. **`-m <marker>` on the command line** — *which tests run this time*. `./tests/run.sh -m smoke` runs only smoke tests; `./tests/run.sh -m "not slow"` excludes slow ones. This is the main lever — decided when we built the marker set: smoke for every push, full regression for `main`/nightly (see "Scaling to 1000+ tests" below).
3. **`tests/report.html`'s dashboard** — *which already-run results are displayed*, no re-run needed. The report is a custom dashboard (`report_theme.js`, rendered from pytest-html's data, not pytest-html's own clunky table) with: a search box (filters by test name), category pills (Toutes/seo/security/a11y/...), and Passed/Failed/Skipped/Reruns checkboxes — all combine (AND). Tests are grouped into collapsible accordions by domain folder; a group with a failure auto-opens, a fully-green group stays collapsed.

`.env.test` controls runtime behavior, not test selection: `TEST_HEADLESS` (1=headless/CI, 0=visible window for local debugging — decided to keep configurable rather than hardcode either way), `TEST_BASE_URL` + `TEST_BASE_URL_STAGING`/`_PROD` (switched via `--env=staging`), `TEST_BROWSER` (chrome/firefox), `TEST_MOBILE_WIDTH/HEIGHT/DPR` (mobile emulation viewport — explicit metrics, not a named device, because Chrome's built-in device list changes between versions and breaks a hardcoded name).

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

Run `/e2e-audit` or `/e2e-init` — both auto-generate a CI workflow (GitHub Actions / GitLab CI / etc.) adapted to the chosen framework at the end of setup (Step 6 of `/e2e-audit`).

## gitignore

Append `gitignore-snippet.txt` to the project's `.gitignore` (done automatically by `/e2e-init`).
