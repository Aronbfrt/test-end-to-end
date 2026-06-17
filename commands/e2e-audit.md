---
description: Full automatic site audit — discovers every route/form/entity via static code analysis, generates and runs basic + SEO + security + accessibility + performance + responsive tests. Zero manual input required. Triggers on "teste-moi le site", "audit le site", "teste le site complet", "test complet", or /e2e-audit.
---

# /e2e-audit

End-to-end, zero-manual-work site audit. Discovers everything from the code (never asks the user to fill in routes/fields), generates real test files into `tests/`, runs the full suite, and reports findings with security issues flagged prominently.

This is the **superset** of `/e2e-init` — run this instead when the user wants "everything" rather than a guided manual setup.

## Step 1 — Detect and migrate existing tests, then bootstrap infra

### Scan for existing tests first

```bash
find . \( \
  -name "*.test.js" -o -name "*.spec.js" -o -name "*.test.ts" -o -name "*.spec.ts" \
  -o -name "*.test.jsx" -o -name "*.spec.jsx" -o -name "*.test.tsx" -o -name "*.spec.tsx" \
  -o -name "*.cy.js" -o -name "*.cy.ts" \
  -o -name "*Test.php" -o -name "*Spec.php" \
  -o -name "*.robot" -o -name "*.resource" \
  -o -name "*.feature" \
  -o -name "*_test.go" \
  -o -name "*_spec.rb" -o -name "*_test.rb" \
  -o -name "*Test.java" -o -name "*Tests.java" \
  -o -name "*Test.cs" -o -name "*Tests.cs" \
  -o -name "*.side" \
  -o -name "cypress.config.*" -o -name "playwright.config.*" \
  -o -name "jest.config.*" -o -name "vitest.config.*" \
  -o -name "wdio.conf.*" \
\) 2>/dev/null | grep -v node_modules | grep -v vendor | grep -v ".git"
```

**If existing tests found — migrate them before generating anything new:**

For each test file found, read it and convert its test logic to Python/pytest:

| Source format | File pattern | Conversion rule |
|---|---|---|
| Jest / Vitest | `*.test.js/ts` | `describe` → class, `it`/`test` → method, `expect(x).toBe(y)` → `assert x == y` |
| Cypress | `*.cy.js/ts` | `cy.visit(url)` → `driver.get(url)`, `cy.get(sel)` → `find_element(By.CSS_SELECTOR, sel)` |
| Playwright | `*.spec.ts` | `page.goto(url)` → `driver.get(url)`, `page.locator(sel)` → `find_element(By.CSS_SELECTOR, sel)` |
| WebdriverIO | `wdio.conf.*` + spec files | `browser.url(url)` → `driver.get(url)`, `$(sel)` → `find_element(By.CSS_SELECTOR, sel)` |
| Robot Framework | `*.robot` / `*.resource` | Each `Test Case` → pytest method, `Open Browser` → `driver.get()`, `Click Element` → `find_element().click()` |
| Cucumber / Gherkin | `*.feature` | Each `Scenario` → class, each `Given`/`When`/`Then` step → sequential lines in one test method |
| PHPUnit | `*Test.php` | `testXxx()` → `def test_xxx()`, `$this->assertEquals(a,b)` → `assert a == b` |
| JUnit / TestNG | `*Test.java` | `@Test void testXxx()` → `def test_xxx()`, `assertEquals(a,b)` → `assert a == b` |
| NUnit / xUnit / MSTest | `*Test.cs` | `[Test] void TestXxx()` → `def test_xxx()`, `Assert.AreEqual(a,b)` → `assert a == b` |
| RSpec | `*_spec.rb` | `describe`/`it` → class/method, `expect(x).to eq(y)` → `assert x == y` |
| Minitest | `*_test.rb` | `def test_xxx` → `def test_xxx`, `assert_equal a, b` → `assert a == b` |
| Go test | `*_test.go` | `func TestXxx(t *testing.T)` → `def test_xxx()`, `t.Errorf(...)` → `assert False, "..."` |
| Selenium IDE | `*.side` | JSON → parse `commands` array, `open` → `driver.get()`, `click` → `find_element().click()` |

Conversion rules:
- Place converted file in `tests/<same_domain>/test_<original_name>.py`
- All CSS/XPath/ID selectors → extracted to `tests/pages/<page_name>.py`, never inline
- Preserve test intent exactly — only syntax changes, never the assertion logic
- Mark each converted test: `# converted from <original_file>`
- Delete the original file after successful conversion
- If the original uses a config file (cypress.config.*, wdio.conf.*) that becomes unused → delete it too

**If no existing tests found:** proceed directly to bootstrap.

### Bootstrap infra

```bash
test -f tests/conftest.py
```
If `tests/` doesn't exist yet: run the full `/e2e-init` copy step (`cp -r ~/.claude/templates/e2e ./tests/`, move `pytest.ini` + `.env.test` to project root, append `gitignore-snippet.txt`, `chmod +x`). Skip re-copying if `tests/` already exists — only add to it.

## Step 2 — Discover everything via static analysis (no live crawling, no guessing)

Detect the stack first (composer.json → PHP, pom.xml/build.gradle → Java/Spring, package.json with next → Next.js, etc.), then per stack:

### Routes / pages
- **PHP vanilla**: grep router/dispatcher file(s) for path → controller mappings (`switch($_SERVER['REQUEST_URI'])`, `$router->get(...)`, front-controller patterns). Also glob `public/*.php` if routing is file-based.
- **Spring Boot**: grep `@GetMapping`, `@PostMapping`, `@RequestMapping` across `src/main/java/**/controller/**` — extract the path value and HTTP method.
- **Next.js**: `find app -name page.tsx -o -name page.jsx` (App Router) or `find pages -name "*.tsx"` (Pages Router) — folder/file path IS the route.
- **Other**: ask the user only if genuinely nothing matches a known convention.

Classify each discovered route into: public page, auth page (login/register/logout), admin page, API endpoint.

### Forms
Grep templates/views for `<form` blocks, extract `action`/method and every `name=` attribute inside. This gives exact field names for contact forms, registration, checkout — no placeholder guessing.

### Entities / admin CRUD
- PHP: look for admin controllers handling create/edit/delete per resource, or DB migrations/schema for table names.
- Spring: JPA `@Entity` classes + their `Repository`/`Controller` pairs.
- Next.js: API routes under `app/api/<entity>/route.ts` or Prisma schema models.

### Auth
Find the login route, the field names used (`email`/`username`), the session/cookie mechanism, and one path that requires authentication (for the auth-bypass security check).

## Step 3 — Generate test files (fill placeholders, never leave a TODO)

Update existing templates directly with the real discovered values — don't ask the user to do step 4 of `/e2e-init` manually:

- `tests/pages/*.py` — real selectors for every discovered form field
- `tests/public/test_public.py` → `PUBLIC_PAGES` = every discovered public route
- `tests/seo/test_seo.py` → `SEO_PAGES` = every discovered public + product/listing route
- `tests/auth/test_auth.py` — real login path + field names
- `tests/admin/test_admin.py` + one `tests/admin_<entity>/` folder per discovered entity (copy `admin_clients` as the template, rename)
- `tests/contact/test_contact.py` — real form path + field names
- `tests/checkout/test_checkout.py` — real checkout path, or delete the whole folder if no Stripe/payment found
- `tests/conftest.py` → `ADMIN_DASHBOARD_PATH` set to the real dashboard route

### Security tests — one generated file per discovered form

For **every** discovered form (contact, register, login, checkout, any admin create form), generate `tests/security/test_security_<form_name>.py`:

```python
"""Security — <form_name> form. Auto-generated by /e2e-audit from the discovered route."""
import pytest
from tests.utils.helpers import url
from tests.utils.security_checks import check_no_sql_error_leak, check_reflected_input_escaped
from selenium.webdriver.common.by import By

PATH = '<discovered_path>'
INPUT = (By.NAME, '<discovered_field>')   # pick the main free-text field (message/name/search)
SUBMIT = (By.CSS_SELECTOR, '[type=submit]')


@pytest.mark.security
class TestSecurity<FormName>:
    def test_01_no_sql_error_leak(self, user_driver):
        check_no_sql_error_leak(user_driver, INPUT, SUBMIT, url_to_load=url(PATH))

    def test_02_reflected_input_escaped(self, user_driver):
        check_reflected_input_escaped(user_driver, INPUT, SUBMIT, url_to_load=url(PATH))
```

Adapt `INPUT` per form's actual free-text field. Skip forms with no free-text input (e.g. a pure button/checkbox form) — note why in a one-line comment, don't generate a meaningless test.

### SEO — one entry per discovered content page

Fill `SEO_PAGES` in `tests/seo/test_seo.py` with every public + listing/detail page found. For a catalog-style site, include one representative detail page (e.g. first product found via a quick DB/fixture read), not all of them — SEO checks are structural, one sample per template is enough.

## Step 4 — Run + auto-fix loop

`bootstrap.py` auto-installs missing deps. If the app isn't running yet, check `CLAUDE.md`/`package.json`/`README` for the real start command — don't guess.

Run the full suite, then **fix and re-run in a loop** until green or genuinely stuck:

```bash
pytest --headed --tb=short 2>&1 | tee /tmp/pytest_output.txt
```

### Diagnose each failure and fix immediately:

**Test is wrong** (bad selector, wrong URL, wrong assertion, too strict for this site) → fix the test file, re-run that single test:
```bash
pytest --headed tests/<module>::<TestClass>::<test_name> --tb=short
```

**App is broken** (real bug — missing header, broken form, wrong redirect) → this is a finding, NOT a test fix. Keep the test, flag it in the report.

**Fixture/config issue** (wrong `BASE_URL`, missing `.env.test` value, wrong admin path) → fix `.env.test` or `conftest.py`, re-run.

**Selector drifted** → update `tests/pages/*.py` with the real current selector. Never hardcode selectors in test files.

### Fix iteration rules:

- Fix up to **3 consecutive failures** on the same test before marking it "needs human review"
- After each fix: re-run the fixed test alone, then run the full suite once all fixes are done
- Max **3 full suite iterations** total — remaining failures after 3 rounds = real findings
- Never delete a failing test to make the suite green
- Never touch security test assertions — a security test failure = real vulnerability, report it

### Auto-fixable vs. real finding:

| Symptom | Auto-fix | Report as finding |
|---|---|---|
| Wrong selector in test | ✅ Fix `pages/*.py` | — |
| URL mismatch in test | ✅ Fix test path | — |
| Test asserts HTTPS but runs HTTP locally | ✅ Update assertion | note it |
| Missing HTTP security header | — | 🔒 Real finding |
| No sitemap.xml | — | SEO finding |
| Broken auth flow | — | Functional finding |
| Server error 500 | — | Functional finding |

## Step 5 — Final report

After the fix loop, summarize in order:

1. **Security findings** — relay `[SECURITY] <what> — <why> — <fix>` verbatim. Red 🔒 in `tests/report.html`.
2. **SEO findings** — `[SEO] <what> — <why>` verbatim.
3. **Functional failures** — what broke and where (auth, admin, checkout, contact).
4. **Skipped tests** — relay `reason=` verbatim (a skip is correct if the feature genuinely doesn't exist).
5. **Auto-fixes applied** — every test file changed and why.
6. **Pass count / total**, link to `tests/report.html`.

Never say "tests passed" without checking the actual exit code — pytest exits 0 even with skips, and a wall of skips hiding coverage gaps is itself a finding.

## Re-running after code changes

Re-running `/e2e-audit` is idempotent for re-discovery (routes/forms re-scanned), but it won't blindly overwrite hand-edited test files — diff before overwriting anything that already has non-template content, and ask before replacing custom edits.
