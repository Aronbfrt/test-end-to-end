---
description: Full automatic site audit — discovers every route/form/entity via static code analysis, generates and runs basic + SEO + security + accessibility + performance + responsive tests. Zero manual input required. Triggers on "teste-moi le site", "audit le site", "teste le site complet", "test complet", or /e2e-audit.
---

# /e2e-audit

End-to-end, zero-manual-work site audit. Discovers everything from the code (never asks the user to fill in routes/fields), generates real test files into `tests/`, runs the full suite, and reports findings with security issues flagged prominently.

This is the **superset** of `/e2e-init` — run this instead when the user wants "everything" rather than a guided manual setup.

## Step 1 — Analyse des conventions existantes, migration, bootstrap

### 1a — Lire les conventions du projet avant de toucher quoi que ce soit

Avant toute migration ou génération, lire 3 à 5 fichiers représentatifs du projet (code source, pas les tests) pour détecter :

- **Langue dominante** : nommage des variables/fonctions (camelCase, snake_case, PascalCase)
- **Style d'assertion existant** : si des tests existent déjà, lire comment ils écrivent les assertions, les setup/teardown, les noms de méthodes
- **Structure des dossiers** : est-ce que le projet utilise `src/`, `app/`, `lib/`, modules par feature ou par type ?
- **Patterns de test existants** : Page Object Model ? Helper functions ? Fixtures centralisées ? Data factories ?

**Ces conventions dictent la façon dont les nouveaux tests seront écrits.** Un projet qui nomme tout en camelCase aura des classes `TestUserAuth` (pas `test_user_auth`). Un projet avec des helpers `createTestUser()` aura ses fixtures dans le même style.

### 1b — Scanner les tests existants

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

**Si des tests existants sont trouvés — les migrer avant de générer quoi que ce soit :**

Lire chaque fichier en entier, comprendre l'intention de chaque test, puis le réécrire en Python/pytest en respectant les règles de conversion ET les conventions lues en 1a.

| Format source | Pattern fichier | Règle de conversion |
|---|---|---|
| Jest / Vitest | `*.test.js/ts` | `describe` → class, `it`/`test` → method, `expect(x).toBe(y)` → `assert x == y` |
| Cypress | `*.cy.js/ts` | `cy.visit(url)` → `driver.get(url)`, `cy.get(sel)` → `find_element(By.CSS_SELECTOR, sel)` |
| Playwright | `*.spec.ts` | `page.goto(url)` → `driver.get(url)`, `page.locator(sel)` → `find_element(By.CSS_SELECTOR, sel)` |
| WebdriverIO | `wdio.conf.*` + specs | `browser.url(url)` → `driver.get(url)`, `$(sel)` → `find_element(By.CSS_SELECTOR, sel)` |
| Robot Framework | `*.robot` / `*.resource` | Each `Test Case` → pytest method, `Open Browser` → `driver.get()`, `Click Element` → `find_element().click()` |
| Cucumber / Gherkin | `*.feature` | Each `Scenario` → class, chaque step `Given`/`When`/`Then` → lignes séquentielles dans la méthode |
| PHPUnit | `*Test.php` | `testXxx()` → `def test_xxx()`, `$this->assertEquals(a,b)` → `assert a == b` |
| JUnit / TestNG | `*Test.java` | `@Test void testXxx()` → `def test_xxx()`, `assertEquals(a,b)` → `assert a == b` |
| NUnit / xUnit / MSTest | `*Test.cs` | `[Test] void TestXxx()` → `def test_xxx()`, `Assert.AreEqual(a,b)` → `assert a == b` |
| RSpec | `*_spec.rb` | `describe`/`it` → class/method, `expect(x).to eq(y)` → `assert x == y` |
| Minitest | `*_test.rb` | `def test_xxx` → `def test_xxx`, `assert_equal a, b` → `assert a == b` |
| Go test | `*_test.go` | `func TestXxx(t *testing.T)` → `def test_xxx()`, `t.Errorf(...)` → `assert False, "..."` |
| Selenium IDE | `*.side` | JSON → parse `commands`, `open` → `driver.get()`, `click` → `find_element().click()` |

**Règles de migration adaptatives (priorité absolue) :**
- Placer le fichier converti dans `tests/<même_domaine_que_l_original>/test_<nom_original>.py` — miroir de la structure existante, pas une réorganisation forcée
- Si l'original avait des Page Objects → les conserver dans `tests/pages/` avec le même nommage
- Si l'original avait des helpers/fixtures → les porter dans `tests/conftest.py` ou `tests/utils/` selon le pattern déjà présent
- Si l'original utilisait des data factories → recréer le même pattern en Python
- Préserver l'intention du test exactement — seule la syntaxe change, jamais la logique d'assertion
- Marquer chaque test converti : `# migrated from <fichier_original>`
- Supprimer le fichier original après conversion réussie
- Si le fichier original utilise un config (cypress.config.*, wdio.conf.*) devenu inutile → le supprimer

**Si aucun test existant :** aller directement au bootstrap.

### 1c — Bootstrap infra

```bash
test -f tests/conftest.py
```
Si `tests/` n'existe pas encore : copier le template (`cp -r ~/.claude/templates/e2e ./tests/`, déplacer `pytest.ini` + `.env.test` à la racine, appliquer `gitignore-snippet.txt`, `chmod +x`). Si `tests/` existe déjà → ne rien écraser, compléter seulement.

## Step 2 — Découverte complète par analyse statique (zéro crawl live, zéro devinette)

### 2a — Détecter le stack exact

Lire les fichiers marqueurs dans cet ordre, sans s'arrêter au premier match (un projet peut être Next.js + PHP API) :

| Fichier trouvé | Stack / Framework |
|---|---|
| `composer.json` (sans Laravel) | PHP vanilla |
| `composer.json` + `artisan` | Laravel |
| `composer.json` + `bin/console` | Symfony |
| `pom.xml` / `build.gradle` | Java (Spring Boot si `@SpringBootApplication` trouvé) |
| `package.json` + `"next"` | Next.js (vérifier App Router `app/` vs Pages Router `pages/`) |
| `package.json` + `"nuxt"` | Nuxt.js |
| `package.json` + `"@angular/core"` | Angular |
| `package.json` + `"svelte"` | Svelte / SvelteKit |
| `package.json` + `"vue"` | Vue.js |
| `package.json` + `"express"` | Express/Node.js |
| `manage.py` | Django |
| `app.py` / `wsgi.py` + `flask` in requirements | Flask |
| `main.py` + `fastapi` in requirements | FastAPI |
| `Gemfile` + `rails` | Ruby on Rails |
| `go.mod` | Go (détecter gin/echo/fiber/chi dans les imports) |
| `Cargo.toml` | Rust (détecter actix-web/axum) |
| `mix.exs` | Elixir/Phoenix |
| `pubspec.yaml` | Flutter/Dart |

Pour chaque stack détecté, appliquer la méthode de découverte de routes correspondante ci-dessous.

### 2b — Découverte des routes par stack

- **PHP vanilla** : grep fichier(s) router/dispatcher pour mappings path → controller (`switch($_SERVER['REQUEST_URI'])`, `$router->get(...)`, patterns front-controller). Glob `public/*.php` si routing file-based.
- **Laravel** : grep `routes/web.php` + `routes/api.php` pour `Route::get/post/put/delete(...)`. Extraire le path et le controller.
- **Symfony** : grep annotations `@Route(...)` ou YAML `config/routes.yaml`.
- **Spring Boot** : grep `@GetMapping`, `@PostMapping`, `@RequestMapping` dans `src/main/java/**/controller/**`.
- **Next.js App Router** : `find app -name "page.tsx" -o -name "page.jsx"` — le chemin dossier EST la route. Détecter aussi `route.ts` pour les API routes.
- **Next.js Pages Router** : `find pages -name "*.tsx" -o -name "*.jsx"` (exclure `_app`, `_document`, `api/`).
- **Django** : grep `urlpatterns` dans tous les `urls.py`. Tracer jusqu'aux views.
- **Flask** : grep `@app.route(...)` et `@blueprint.route(...)`.
- **FastAPI** : grep `@app.get/post/put/delete(...)` et les routers.
- **Rails** : lire `config/routes.rb`, extraire `resources :x`, `get '...'`, `post '...'`.
- **Express** : grep `router.get/post/put/delete(...)` et `app.get/post(...)`.
- **Go** : grep les handlers selon le framework (gin: `r.GET(...)`, echo: `e.GET(...)`, chi: `r.Get(...)`).
- **Nuxt/Vue/Svelte/Angular** : `find src -name "*.vue" -o -name "*.svelte"` / lire le router config pour les routes déclarées.

### 2c — Découverte des formulaires

Grep templates/vues pour blocs `<form`, extraire `action`/method et chaque attribut `name=` à l'intérieur. Donne les noms de champs exacts pour chaque formulaire — zéro placeholder.

Pour les SPA (React/Vue/Svelte/Angular) : grep les composants pour `<form`, `onSubmit`, `handleSubmit`, `v-on:submit`, `(ngSubmit)` — extraire les noms de champs des `useState`/`ref`/`FormControl`.

### 2d — Entités / CRUD admin

- PHP/Laravel/Symfony : controllers admin + migrations DB pour noms de tables
- Spring : classes `@Entity` JPA + leurs `Repository`/`Controller`
- Next.js/Node : routes API sous `app/api/<entity>/route.ts` ou modèles Prisma/Drizzle
- Rails : modèles `app/models/*.rb` + scaffold controllers
- Django : modèles `models.py` + vues admin
- Go/Rust : structs avec handlers CRUD

### 2e — Authentification

Trouver la route de login, les noms de champs utilisés (pas d'hypothèse `email`/`password`), le mécanisme de session (cookie, JWT, session PHP, devise, passport, etc.), et un chemin qui nécessite une auth (pour le check security auth-bypass).

## Step 3 — Generate test files (fully adaptive — zero assumed structure)

**Never pre-create folders. Never generate a test file for a feature that doesn't exist in the project.**
Every folder and file is derived exclusively from what Step 2 discovered.

### Folder naming rule

Name each folder after what it actually tests in this project — not after a generic category:

| What was discovered | Folder name |
|---|---|
| Login/register/logout routes | `tests/auth/` |
| Admin dashboard or back-office | `tests/admin/` |
| A contact form | `tests/contact/` |
| A checkout/payment flow | `tests/checkout/` |
| A product catalog | `tests/products/` |
| A blog with posts | `tests/blog/` |
| A dashboard (SaaS) | `tests/dashboard/` |
| API endpoints | `tests/api/` |
| Anything else | `tests/<what_it_is>/` |

**If a feature wasn't found → its folder is not created. No empty stubs.**

### Files to always generate (every project has these)

- `tests/pages/<page_name>.py` — one file per discovered page/form, contains only selectors (CSS/XPath/ID). Never inline selectors in test files.
- `tests/public/test_public.py` → `PUBLIC_PAGES` = every discovered public route (always exists, every project has at least one page)
- `tests/seo/test_seo.py` → `SEO_PAGES` = every public + listing/detail page (one representative sample per template type, not all records)

### Files to generate only if discovered

Generate each file below **only** if the corresponding feature was found in Step 2:

- `tests/auth/test_auth.py` — only if login/register route found. Use the real field names from the form, not `email`/`password` defaults.
- `tests/admin/test_admin.py` — only if an admin area was found. Set `ADMIN_DASHBOARD_PATH` in `tests/conftest.py` to the real path.
- `tests/admin_<entity>/test_<entity>.py` — one per discovered CRUD entity (products, users, orders…). Skip entirely if no entities found.
- `tests/contact/test_contact.py` — only if a contact form was found.
- `tests/checkout/test_checkout.py` — only if Stripe/payment route found.
- `tests/<custom_feature>/test_<custom_feature>.py` — any feature specific to this project (a booking system, a quiz, a map, a live chat, etc.) gets its own folder named after itself.

### How to write each generated test

- Use only selectors discovered from the actual HTML/templates — never guess `#email`, `.btn`, `input[type=submit]` without verifying they exist
- Test class name = what it tests: `TestProductCatalog`, `TestCheckoutFlow`, `TestBlogPost`
- One class per domain area, one method per user scenario
- Assert the real expected outcome for this specific app, not a generic "page loads"

### Security tests — one file per discovered form

For **every** discovered form generate `tests/security/test_security_<form_name>.py`:

```python
"""Security — <form_name> form. Auto-generated by /e2e-audit."""
import pytest
from tests.utils.helpers import url
from tests.utils.security_checks import check_no_sql_error_leak, check_reflected_input_escaped
from selenium.webdriver.common.by import By

PATH = '<discovered_path>'
INPUT = (By.NAME, '<discovered_field>')   # actual free-text field from the form
SUBMIT = (By.CSS_SELECTOR, '<actual_submit_selector>')


@pytest.mark.security
class TestSecurity<FormName>:
    def test_01_no_sql_error_leak(self, user_driver):
        check_no_sql_error_leak(user_driver, INPUT, SUBMIT, url_to_load=url(PATH))

    def test_02_reflected_input_escaped(self, user_driver):
        check_reflected_input_escaped(user_driver, INPUT, SUBMIT, url_to_load=url(PATH))
```

Skip if no free-text field exists (pure button/checkbox form) — add a one-line comment explaining why.

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
