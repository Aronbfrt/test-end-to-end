---
description: La révolution des tests end-to-end. Audit automatique complet du site — découvre chaque route/form/entité par analyse statique du code (n'importe quel langage/framework), génère et lance tests basiques + SEO + sécurité + accessibilité + performance + responsive. Idempotent — synchronise les nouvelles routes sans toucher aux tests déjà écrits à la main. Zéro saisie manuelle. Déclencheurs : "teste-moi le site", "audit le site", "teste le site complet", "test complet", ou /e2e-audit.
---

# /e2e-audit

End-to-end, zero-manual-work site audit. Discovers everything from the code (never asks the user to fill in routes/fields), generates real test files into `tests/`, runs the full suite, and reports findings with security issues flagged prominently.

This is the **superset** of `/e2e-init` — run this instead when the user wants "everything" rather than a guided manual setup. Safe to re-run any time the codebase changes — it syncs, it doesn't blindly regenerate.

## Step 0 — staleness check (always run first, before touching anything)

```bash
test -f tests/conftest.py && echo EXISTS || echo MISSING
```

- **MISSING** → go straight to Step 1 (fresh install).
- **EXISTS** → don't recopy the template. Instead:
  1. Re-run the discovery in Step 2 to get the current route/form/entity list.
  2. For each discovered item, check whether a corresponding test already exists (e.g. a route → does `PUBLIC_PAGES`/`SEO_PAGES` already contain it, does an `admin_<entity>/` folder already exist, does a `security/test_security_<form>.py` already exist for that form).
  3. **Already covered** → leave that file untouched. Don't rewrite, don't reformat, don't "improve" — a hand-edited test is more trustworthy than a regenerated one.
  4. **New, not covered yet** → add it (new entry in the relevant list, new file for a new entity/form). Never delete an existing test for a route that's gone unless asked — flag it instead ("route X no longer found in code, test Y may be stale, remove it?").
  5. If a discovered route's signature changed (e.g. a form field was renamed) and the existing test would now fail for a reason unrelated to a real bug (selector drift, not a regression), update just that selector in `pages/*.py` — that's the one exception to "don't touch existing tests", since a stale selector isn't a meaningful edit, it's keeping the same test working.
  6. Summarize what changed before running: "X routes already covered, Y new tests added, Z possibly-stale tests flagged" — don't silently regenerate everything every time.

## Step 1 — Bootstrap test infra (fresh install only)

```bash
cp -r "${CLAUDE_PLUGIN_ROOT}/templates/e2e" ./tests/
mv tests/pytest.ini.project-root ./pytest.ini
mv tests/.env.test.example .env.test
cat tests/gitignore-snippet.txt >> .gitignore
chmod +x tests/run.sh tests/bootstrap.py
```

## Step 2 — Discover everything via static analysis (any language, no live crawling, no guessing)

Detect the stack first by checking for marker files, in this order — **this list is a starting point, not exhaustive; if the project uses something not listed, find the routing convention by reading the entry point / framework docs implied by the marker file, don't give up and ask the user**:

| Marker file | Stack | Where routes live |
|---|---|---|
| `composer.json` | PHP (vanilla or framework) | router/dispatcher file, or `public/*.php` if file-based routing |
| `pom.xml` / `build.gradle` | Java (Spring) | `@GetMapping`/`@PostMapping`/`@RequestMapping` in `**/controller/**` |
| `package.json` with `next` dep | Next.js | `app/**/page.tsx` (App Router) or `pages/**/*.tsx` (Pages Router) — path = route |
| `package.json` with `express`/`fastify`/`koa` | Node API | `app.get(...)`/`router.get(...)` calls |
| `manage.py` + `settings.py` | Django | `urlpatterns` in `**/urls.py` |
| `app.py`/`wsgi.py` + Flask import | Flask | `@app.route(...)` decorators |
| `Gemfile` + `config/routes.rb` | Ruby on Rails | `config/routes.rb` |
| `go.mod` | Go (gin/echo/chi/net-http) | `router.GET(...)`/`mux.HandleFunc(...)` calls |
| `Cargo.toml` | Rust (actix/axum) | `.route(...)` / `#[get(...)]` macros |
| `mix.exs` | Elixir (Phoenix) | `router.ex` `get "/path", ...` |

Grep the matching pattern across the source tree, extract path + HTTP method for every route found. Classify each into: public page, auth page (login/register/logout), admin page, API endpoint.

### Forms
Grep templates/views (`.php`, `.html`, `.erb`, `.jsx`/`.tsx`, `.ejs`, whatever the stack uses) for `<form` blocks, extract `action`/method and every `name=` attribute inside. Exact field names — never placeholder-guess.

### Entities / admin CRUD
- SQL-backed: migrations or schema file → table names; or ORM model classes (JPA `@Entity`, Eloquent models, Django models, ActiveRecord, Prisma schema, Diesel/SeaORM structs) + their controller/route pair.
- Match each entity to its admin create/edit/delete routes from Step 2's route list.

### Auth
Login route, field names (`email`/`username`), session/cookie mechanism, one path requiring authentication (for the auth-bypass security check).

## Step 3 — Generate / sync test files (fill placeholders, never leave a TODO, never overwrite hand-edited content)

For a **fresh install**, fill every placeholder directly with real discovered values:

- `tests/pages/*.py` — real selectors for every discovered form field
- `tests/public/test_public.py` → `PUBLIC_PAGES` = every discovered public route
- `tests/seo/test_seo.py` → `SEO_PAGES` = every discovered public + one representative listing/detail route per template
- `tests/auth/test_auth.py` — real login path + field names
- `tests/admin/test_admin.py` + one `tests/admin_<entity>/` folder per discovered entity (copy `admin_clients` as the template, rename)
- `tests/contact/test_contact.py` — real form path + field names
- `tests/checkout/test_checkout.py` — real checkout path, or delete the whole folder if no payment flow found
- `tests/conftest.py` → `ADMIN_DASHBOARD_PATH` set to the real dashboard route

For a **sync** (existing suite, see Step 0), only touch the diff: append new entries to `PUBLIC_PAGES`/`SEO_PAGES`, add new `admin_<entity>/` folders for new entities, add new `security/test_security_<form>.py` for new forms. Leave everything already covered exactly as-is.

### Security tests — one generated file per discovered form (skip if it already exists, see Step 0)

```python
"""Security — <form_name> form. Auto-generated by /e2e-audit from the discovered route."""
import pytest
from tests.utils.helpers import url
from tests.utils.security_checks import check_no_sql_error_leak, check_reflected_input_escaped
from selenium.webdriver.common.by import By

PATH = '<discovered_path>'
INPUT = (By.NAME, '<discovered_field>')   # the main free-text field (message/name/search)
SUBMIT = (By.CSS_SELECTOR, '[type=submit]')


@pytest.mark.security
class TestSecurity<FormName>:
    def test_01_no_sql_error_leak(self, user_driver):
        check_no_sql_error_leak(user_driver, INPUT, SUBMIT, url_to_load=url(PATH))

    def test_02_reflected_input_escaped(self, user_driver):
        check_reflected_input_escaped(user_driver, INPUT, SUBMIT, url_to_load=url(PATH))
```

Skip forms with no free-text input (pure button/checkbox) — note why in a one-line comment, don't generate a meaningless test.

## Step 4 — Run everything

```bash
./tests/run.sh
```
`bootstrap.py` auto-installs whatever's missing, for any language the *test suite* runs in (it's always Python/pytest regardless of the target app's language — the app under test can be PHP/Java/Go/whatever). If the app isn't running yet, check `CLAUDE.md`/`package.json`/`README`/`Makefile` for the real start command before asking the user — don't guess one.

## Step 5 — Diagnose and fix, then re-verify (don't just report and stop)

For every failure and every skip, before writing the summary:

1. **Read the actual message.** `[SECURITY]`/`[SEO]` failures already say what/why/how to fix. Functional failures need a real traceback read.
2. **Decide what's actually wrong** — almost always one of:
   - **The project's code is wrong** (missing canonical tag, unescaped output, missing security header, broken form field, route returns the wrong thing) → fix the project's source code. This is the normal case — go fix it.
   - **The test itself is wrong** (selector drifted from a real markup change, wrong path from a stale discovery, assumption that doesn't hold for this project) → fix the test/selector in `pages/*.py` or the test file. Only this case justifies touching the test.
   - **The skip is correct, not a bug** (genuinely no mobile nav by design, no subscription feature) → leave it, no fix needed, just say so clearly in the summary.
   - **Neither** — fixing it needs a decision only the human can make (real content for a missing meta description, a business call on whether `/admin` should really be public, a data dependency) → don't guess, flag it explicitly instead of inventing a fix.
3. **Apply the fix immediately** — in the project's actual source files for the "code is wrong" case. Stay in scope: fix the specific thing the test caught, don't refactor around it. Don't pause to ask before fixing an obvious, in-scope, non-destructive bug (missing canonical tag, unescaped output, missing header, wrong selector) — just do it and move to the next one. Only stop to ask when a fix would touch auth/payment logic, delete data, or change a business rule.
4. **Re-run just the affected test(s)** to confirm: `./tests/run.sh tests/<domain> -k <test_name> -v` (or copy the exact command from the report's "🔁 Copier la commande" button on that row).
5. **Keep going** — move to the next failure/skip and repeat steps 1-4, in the same pass, no pause in between. Don't stop after "one retry" as a rule; stop on a given item only when either it's green, or a second honest fix attempt on that *specific* item didn't take (then flag it and move on to the rest — one stuck item doesn't block fixing everything else). Never "fix" a test by weakening or deleting its assertion just to turn it green.
6. **Process every failure and every skip this way before reporting** — the summary in Step 6 comes after the fix pass is done, not instead of it.

This loop is the whole point of `/e2e-audit` — a report nobody acts on is wasted work.

## Step 6 — Report back

Summarize, in this order:

1. **Sync summary** (if this was a re-run) — "X routes already covered, Y new tests added, Z flagged as possibly stale."
2. **Fixed automatically** — what was wrong, what got changed, confirmed green by re-run.
3. **Security findings still open** (if any survived a fix attempt) — relay the `[SÉCURITÉ] <quoi> — <pourquoi> — <fix>` message verbatim. Point to the red 🔒 badge in `tests/report.html`'s Category column.
4. **SEO findings still open** — same pattern, `[SEO] <quoi> — <pourquoi>`.
5. **Flagged for human decision** — what couldn't be auto-fixed and why.
6. **Skipped tests** — relay the explicit `reason=` on every skip; say plainly when a skip is correct, not a gap.
7. **Pass count / total**, link to `tests/report.html`.

Never say "tests passed" without checking the actual exit code and reading `tests/report.html` numbers — pytest can exit 0 with skips, and a wall of skips hiding real coverage gaps is itself a finding worth surfacing.
