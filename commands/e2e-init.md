---
description: La révolution des tests end-to-end. Initialise la structure de tests E2E (pytest + Selenium) dans le projet courant. Copie le template de base et l'adapte aux routes et entités du projet.
---

# /e2e-init

Initialize E2E tests for this project using pytest + Selenium. Structure mirrors a proven, large-scale setup (300+ tests in production): flat domain folders, Page Object Model, session-scoped browsers, auto-installing bootstrap, enriched HTML report. Works for any backend (PHP, Java/Spring, Next.js...) — nothing in the template is framework-specific beyond the route paths, which get adapted in step 4.

## Structure produced

```
project-root/
├── pytest.ini                     # moved here from tests/, NOT left inside tests/
├── .env.test                      # moved here from tests/.env.test.example
└── tests/
    ├── conftest.py                 # fixtures only
    ├── bootstrap.py / run.sh        # auto-install + run
    ├── utils/                       # browser, helpers, checks, crud_base, stripe_helper, auto_fix
    ├── pages/                       # Page Object Model (selectors)
    └── <domain>/test_<domain>.py    # home, public, auth, contact, admin, admin_<entity>,
                                      # checkout, accessibility, responsive, performance
```

## Steps

1. **Read the project structure** — identify:
   - Login URL and form field names (`email`/`username`, `password`)
   - Admin section URL prefix (`/admin`, `/dashboard`, `/back`) and the dashboard path used to detect "already logged in" (`ADMIN_DASHBOARD_PATH`)
   - Main entities managed (clients, products, orders...) — one `tests/admin_<entity>/` per entity
   - Full list of public pages — added to `tests/public/test_public.py`'s `PUBLIC_PAGES`
   - Contact/quote form path and field names
   - Whether Stripe is used (checkout/subscription paths)
   - Whether the backend exposes a direct API (for the `api` fixture)

2. **Copy base template**:
   ```bash
   cp -r "${CLAUDE_PLUGIN_ROOT}/templates/e2e" ./tests/
   mv tests/pytest.ini.project-root ./pytest.ini
   mv tests/.env.test.example .env.test
   cat tests/gitignore-snippet.txt >> .gitignore
   chmod +x tests/run.sh tests/bootstrap.py
   ```

3. **Adapt `tests/utils/` and `tests/pages/` first** — every domain test depends on them:

   ### `tests/utils/helpers.py`
   - `BASE_URL` comes from `TEST_BASE_URL` env — set the right default in `.env.test`
   - `login()` — adapt `login_path` + field selectors if not `name=email` / `name=password`

   ### `tests/utils/checks.py`
   - `LOAD_TIME_BUDGET_MS` / `MAX_IMAGE_BYTES` — realistic budgets for the stack
   - `BLOCKING_IMPACTS` — keep `{'critical', 'serious'}` unless there's a real reason to loosen it

   ### `tests/pages/*.py`
   - Update every selector tuple to match the real markup (`By.NAME, 'email'` → whatever the project actually uses)
   - Add new Page Object classes for pages that don't fit the 4 provided files

4. **Adapt each domain folder** to the actual project routes:

   - `tests/home/test_home.py` — adjust `HomePage.PATH` if home isn't `/`
   - `tests/public/test_public.py` — fill `PUBLIC_PAGES`, remove placeholders
   - `tests/auth/test_auth.py` — confirm redirect destination after login/register; remove tests for unimplemented features (2FA, password reset)
   - `tests/admin/test_admin.py` — adapt stat-card / sidebar selectors via `pages/admin_pages.py`
   - `tests/admin_clients/` — **copy this folder once per entity** (`admin_products`, `admin_orders`...), rename the class, set `RESOURCE`/`CREATE_PATH`/`LIST_PATH`/`REQUIRED_FIELDS`
   - `tests/contact/test_contact.py` — adapt field names (`nom` vs `name`) in `pages/public_pages.py`'s `ContactPage`
   - `tests/checkout/test_checkout.py` — adapt `CheckoutPage.PATH`/`SubscriptionPage.PATH`; delete the `TestSubscription` class if there's no subscription feature; **keep `test_05_price_not_client_controllable` — security test, always keep**
   - `tests/conftest.py` — set `ADMIN_DASHBOARD_PATH` if not `/admin/dashboard`

5. **Mark smoke tests** — the handful of `@pytest.mark.smoke` tests already placed (home loads, admin login, dashboard loads, contact submit, checkout success) are the critical path. Adjust per project.

6. **Verify setup** (auto-installs anything missing):
   ```bash
   ./tests/run.sh tests/home tests/public -v
   ```

7. **Wire CI** (optional but recommended):
   ```bash
   mkdir -p .github/workflows
   cp tests/ci-e2e-tests.yml .github/workflows/e2e-tests.yml
   ```
   Edit the "Start app" step to the project's actual boot command (`php -S`, `npm run start`, `mvn spring-boot:run`, `docker compose up`...).

8. **Run full suite**:
   ```bash
   ./tests/run.sh
   ```

## Environment variables (`.env.test`, gitignored)

```env
TEST_BASE_URL=http://localhost:8000
TEST_API_URL=http://localhost:8000
TEST_BASE_URL_STAGING=https://staging.example.com
TEST_BASE_URL_PROD=https://example.com
TEST_ADMIN_EMAIL=admin@example.com
TEST_ADMIN_PASS=password
TEST_USER_EMAIL=user@example.com
TEST_USER_PASS=password
TEST_ADMIN_DASHBOARD_PATH=/admin/dashboard
TEST_HEADLESS=1
TEST_BROWSER=chrome
TEST_MOBILE_DEVICE=Pixel 5
TEST_SCREENSHOTS=tests/screenshots
```

`TEST_HEADLESS` is the single toggle for visible vs headless — `TEST_HEADLESS=0 ./tests/run.sh` for local debugging, `1` (default) for CI/server.

## Run specific groups

```bash
./tests/run.sh -m smoke              # critical path, every push
./tests/run.sh -m regression         # full regression, before release
./tests/run.sh -m admin              # admin tests only
./tests/run.sh -m stripe             # stripe tests only
./tests/run.sh -m a11y               # accessibility (axe-core)
./tests/run.sh -m responsive         # breakpoint / mobile
./tests/run.sh -m performance        # load-time / console-error budget
./tests/run.sh tests/contact -v      # one domain folder
./tests/run.sh -n auto --dist=loadscope   # parallel, safe with session-scoped drivers
./tests/run.sh --env=staging         # hits TEST_BASE_URL_STAGING
```

## What's in this setup

- **Zero manual install**: `./tests/run.sh` auto-installs missing pip packages and warns (with the right command) if no Chrome/Chromium binary exists. Nothing to set up by hand beyond Python + a browser.
- **Scales to 1000+ tests**: session-scoped `admin_driver`/`user_driver` (one browser for the whole run, not per test) + `pytest-xdist --dist=loadscope` for safe parallelism. This is what a 300-test production suite (demon-slayer-e-commerce) actually runs on.
- **Page Object Model**: every selector lives in `tests/pages/`, never inline in a test — one markup change updates one line.
- **Enriched HTML report**: failures embed their screenshot + last console errors directly in the report row (no separate folder to dig through), dark theme via `report-style.css`, JUnit XML for CI.
- **Auto-fix mechanism** (`utils/auto_fix.py`): empty by default, opt-in per project for genuinely recurring, safely-automatable failures.
- **`--env` CLI flag**: same suite against dev/staging/prod via `TEST_BASE_URL_<ENV>`.
- **Universal**: nothing framework-specific — adapt the route paths in step 4 and it runs against PHP, Java/Spring, Next.js, anything Selenium can drive.
