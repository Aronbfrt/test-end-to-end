---
description: Full automatic site audit — discovers every route/form/entity via static code analysis, generates and runs basic + SEO + security + accessibility + performance + responsive tests. Zero manual input required. Triggers on "teste-moi le site", "audit le site", "teste le site complet", "test complet", or /e2e-audit.
---

# /e2e-audit

End-to-end, zero-manual-work site audit. Discovers everything from the code (never asks the user to fill in routes/fields), generates real test files into `tests/`, runs the full suite, and reports findings with security issues flagged prominently.

This is the **superset** of `/e2e-init` — run this instead when the user wants "everything" rather than a guided manual setup.

## Step 0 — Onboarding (première fois uniquement)

**Vérifier d'abord :** si `.env.test` contient `TEST_FRAMEWORK=`, le setup a déjà été fait → passer directement au Step 1. Si des réponses sont déjà dans le prompt de l'utilisateur, ne pas reposer ces questions.

Poser **4 à 5 questions** sous forme de liste numérotée avec des propositions cliquables. Adapter selon ce qui est déjà connu (depuis le prompt ou le code). Maximum 5 questions, minimum 4.

---

**1. Quel framework de test veux-tu utiliser ?**
> a) Selenium + pytest (Python) — universel, tout backend
> b) Playwright Python — moderne, async, snapshots
> c) Playwright TypeScript — si projet JS/TS
> d) Cypress — si projet React/Vue/Next.js/Nuxt
> e) Robot Framework — style keyword/acceptance testing
> f) Je fais confiance au plugin (détection auto selon le projet)

**2. Tu veux voir les tests s'exécuter en direct ou en arrière-plan ?**
> a) Headless — invisible, rapide, CI-ready (défaut)
> b) Visible (headed) — voir Chrome s'exécuter en direct

**3. Quelle est l'URL de ton environnement de dev ?**
*(skip si trouvable dans `.env`, scripts `package.json`, ou déjà dit dans le prompt)*
> Répondre librement : `http://localhost:3000`

**4. Quelles catégories de tests veux-tu générer ?**
> a) Tout (fonctionnel + SEO + sécurité + accessibilité + performance + responsive)
> b) Fonctionnel seulement (routes, formulaires, navigation)
> c) Sécurité + fonctionnel
> d) Choix libre — écrire les catégories voulues

**5. Y a-t-il des zones protégées dans l'app (login, espace admin) ?** *(skip si détectable depuis le code)*
> a) Oui, avec login
> b) Oui, avec login + espace admin séparé
> c) Non, tout est public

---

Une fois les réponses obtenues, écrire dans `.env.test` :
```
TEST_FRAMEWORK=<choix: selenium|playwright-python|playwright-ts|cypress|robot>
TEST_HEADLESS=<1 ou 0>
TEST_BASE_URL=<url>
```
→ Les prochains appels à `/e2e-audit` ou `/e2e-init` liront ce fichier et sauteront l'onboarding.

### Correspondance framework → format de génération

| Choix | Fichiers générés | Runner | Format |
|---|---|---|---|
| `selenium` | `tests/**/*.py` + `conftest.py` | `pytest` | Python |
| `playwright-python` | `tests/**/*.py` + `conftest.py` | `pytest-playwright` | Python |
| `playwright-ts` | `tests/**/*.spec.ts` + `playwright.config.ts` | `npx playwright test` | TypeScript |
| `cypress` | `cypress/e2e/**/*.cy.js` + `cypress.config.js` | `npx cypress run` | JavaScript |
| `robot` | `tests/**/*.robot` + resource files | `robot` | Robot Framework |

*Auto-détection (option f) : si `cypress.config.*` existe → Cypress. Si `playwright.config.*` → Playwright. Si projet Python → Selenium. Sinon → Selenium.*

## Step 1 — Analyse des conventions existantes, migration, bootstrap

### 1a — Lire les conventions du projet avant de toucher quoi que ce soit

Avant toute migration ou génération, lire 3 à 5 fichiers représentatifs du projet (code source, pas les tests) pour détecter :

- **Langue humaine** : lire les commentaires, les messages d'erreur, les labels de formulaire pour détecter FR/EN/ES/DE/etc. → nommer les tests dans cette langue. Exemple FR : `test_connexion_echoue_sans_mot_de_passe`. Exemple EN : `test_login_fails_without_password`. Si projet multilingue → utiliser EN (langue de référence du code).
- **Langue de code** : nommage des variables/fonctions (camelCase, snake_case, PascalCase) → respecter dans les classes et méthodes générées
- **Style d'assertion existant** : lire comment les tests existants écrivent les assertions, les setup/teardown, les noms de méthodes
- **Structure des dossiers** : `src/`, `app/`, `lib/`, modules par feature ou par type
- **Patterns de test existants** : Page Object Model ? Helper functions ? Fixtures centralisées ? Data factories ?

**Ces conventions dictent entièrement la façon dont les nouveaux tests seront écrits.** Un projet FR avec snake_case aura `def test_formulaire_contact_champs_requis`. Un projet EN camelCase Cypress aura `it('shows error when required fields are empty')`.

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

Lire chaque fichier en entier, comprendre l'intention de chaque test, puis le réécrire dans le format du `TEST_FRAMEWORK` choisi au Step 0 :
- `selenium` / `playwright-python` → Python/pytest (tableau ci-dessous)
- `playwright-ts` → `.spec.ts` avec `@playwright/test`
- `cypress` → `.cy.js` avec `cy.visit()` / `cy.get()`
- `robot` → `.robot` avec SeleniumLibrary keywords

Respecter les conventions lues en 1a.

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

### 1c — Bootstrap infra (infra uniquement — zéro dossier domaine hardcodé)

```bash
test -f tests/conftest.py
```

Bootstrap selon le framework choisi en Step 0 (`TEST_FRAMEWORK` dans `.env.test`) :

**selenium / playwright-python** (Python) :
```bash
T=~/.claude/templates/e2e
mkdir -p tests
cp $T/__init__.py $T/conftest.py $T/bootstrap.py $T/live_server.py tests/
cp -r $T/utils $T/features $T/report $T/pages tests/
cp -r $T/public $T/seo $T/security $T/accessibility $T/responsive $T/performance tests/
cp $T/pytest.ini.project-root ./pytest.ini 2>/dev/null || true
[ -f .env.test ] || cp $T/.env.test.example .env.test 2>/dev/null || true
cat $T/gitignore-snippet.txt >> .gitignore 2>/dev/null || true
chmod +x tests/bootstrap.py tests/run.sh 2>/dev/null || true
# playwright-python uniquement : remplacer browser.py par version playwright
# pip install pytest-playwright && playwright install
```

**playwright-ts** (TypeScript) :
```bash
mkdir -p tests
cat > playwright.config.ts << 'EOF'
import { defineConfig } from '@playwright/test';
export default defineConfig({ use: { baseURL: process.env.TEST_BASE_URL || 'http://localhost:3000' } });
EOF
npm install -D @playwright/test && npx playwright install
[ -f .env.test ] || echo "TEST_BASE_URL=http://localhost:3000" > .env.test
```

**cypress** (JavaScript) :
```bash
mkdir -p cypress/e2e cypress/support/pages cypress/fixtures
cat > cypress.config.js << 'EOF'
const { defineConfig } = require('cypress');
module.exports = defineConfig({ e2e: { baseUrl: process.env.TEST_BASE_URL || 'http://localhost:3000', specPattern: 'cypress/e2e/**/*.cy.js' } });
EOF
npm install -D cypress
[ -f .env.test ] || echo "TEST_BASE_URL=http://localhost:3000" > .env.test
```

**robot** (Robot Framework) :
```bash
mkdir -p tests/resources tests/variables
echo "*** Variables ***\n\${BASE_URL}    http://localhost:3000\n\${BROWSER}    chrome" > tests/variables/variables.robot
pip install robotframework robotframework-seleniumlibrary
[ -f .env.test ] || echo "TEST_BASE_URL=http://localhost:3000" > .env.test
```

**Ne jamais copier (Python seulement)** : `auth/`, `admin/`, `admin_clients/`, `checkout/`, `contact/`, `home/` — créés uniquement si la feature est trouvée en Step 2.

Si `tests/` (ou `cypress/`) existe déjà → ne rien écraser, compléter seulement.

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

Adapter le chemin et l'extension selon `TEST_FRAMEWORK` :

| Framework | Page Objects | Test public | Test SEO |
|---|---|---|---|
| selenium / playwright-python | `tests/pages/<page>.py` | `tests/public/test_public.py` | `tests/seo/test_seo.py` |
| playwright-ts | `tests/pages/<page>.ts` | `tests/public/public.spec.ts` | `tests/seo/seo.spec.ts` |
| cypress | `cypress/support/pages/<page>.js` | `cypress/e2e/public/public.cy.js` | `cypress/e2e/seo/seo.cy.js` |
| robot | `tests/resources/<page>.resource` | `tests/public/public.robot` | `tests/seo/seo.robot` |

Chaque Page Object contient uniquement les sélecteurs (CSS/XPath/ID) — jamais inline dans les tests.

### Files to generate only if discovered

Générer **uniquement** si la feature est trouvée en Step 2. Adapter l'extension selon `TEST_FRAMEWORK` :

| Feature | Python (selenium/pw-py) | Playwright TS | Cypress | Robot |
|---|---|---|---|---|
| Login/register | `tests/auth/test_auth.py` | `tests/auth/auth.spec.ts` | `cypress/e2e/auth/auth.cy.js` | `tests/auth/auth.robot` |
| Admin area | `tests/admin/test_admin.py` | `tests/admin/admin.spec.ts` | `cypress/e2e/admin/admin.cy.js` | `tests/admin/admin.robot` |
| CRUD entity | `tests/admin_<e>/test_<e>.py` | `tests/admin_<e>/<e>.spec.ts` | `cypress/e2e/admin_<e>/<e>.cy.js` | `tests/admin_<e>/<e>.robot` |
| Contact form | `tests/contact/test_contact.py` | `tests/contact/contact.spec.ts` | `cypress/e2e/contact/contact.cy.js` | `tests/contact/contact.robot` |
| Checkout | `tests/checkout/test_checkout.py` | `tests/checkout/checkout.spec.ts` | `cypress/e2e/checkout/checkout.cy.js` | `tests/checkout/checkout.robot` |
| Feature custom | `tests/<feat>/test_<feat>.py` | `tests/<feat>/<feat>.spec.ts` | `cypress/e2e/<feat>/<feat>.cy.js` | `tests/<feat>/<feat>.robot` |

Pour Python : si admin trouvé, mettre `ADMIN_DASHBOARD_PATH` dans `tests/conftest.py`. Pour les autres frameworks : stocker le path admin dans `cypress.config.js` → `env.adminPath` (Cypress), `playwright.config.ts` → `use.adminPath` (Playwright TS), `tests/variables/variables.robot` → `${ADMIN_PATH}` (Robot).

### Tests API headless (sans navigateur)

Pour chaque endpoint REST/API découvert en Step 2 (routes sous `/api/`, handlers JSON, GraphQL), générer des tests **sans navigateur** — plus rapides, plus stables que Selenium pour des routes purement HTTP.

**Python (tous frameworks Python) :**
```python
# tests/api/test_api_<resource>.py
import requests, os
BASE = os.getenv('TEST_BASE_URL', 'http://localhost:3000')

class TestApi<Resource>:
    def test_get_<resource>_returns_200(self):
        r = requests.get(f'{BASE}/api/<discovered_path>')
        assert r.status_code == 200

    def test_get_<resource>_returns_json(self):
        r = requests.get(f'{BASE}/api/<discovered_path>')
        assert r.headers.get('content-type', '').startswith('application/json')

    def test_post_<resource>_invalid_payload_returns_4xx(self):
        r = requests.post(f'{BASE}/api/<discovered_path>', json={})
        assert r.status_code in (400, 422, 403)
```

**Cypress (pas de navigateur pour API) :**
```javascript
// cypress/e2e/api/api_<resource>.cy.js
describe('API — <resource>', () => {
  it('GET returns 200', () => { cy.request('GET', '/api/<path>').its('status').should('eq', 200); });
  it('POST invalid payload returns 4xx', () => { cy.request({ method: 'POST', url: '/api/<path>', body: {}, failOnStatusCode: false }).its('status').should('be.within', 400, 499); });
});
```

**Playwright TS :**
```typescript
// tests/api/api_<resource>.spec.ts
import { test, expect, request } from '@playwright/test';
test('GET /<resource> returns 200', async () => {
  const ctx = await request.newContext({ baseURL: process.env.TEST_BASE_URL });
  const res = await ctx.get('/api/<path>');
  expect(res.status()).toBe(200);
});
```

Ne générer les tests API que si des endpoints REST sont trouvés. Skiper pour les apps purement server-side sans API JSON.

### How to write each generated test

Adapter le format selon `TEST_FRAMEWORK` lu dans `.env.test` :

#### `selenium` ou `playwright-python` → Python

```python
# tests/<feature>/test_<feature>.py
import pytest
# selenium:
from selenium.webdriver.common.by import By
from tests.pages.<page> import <PageClass>
# playwright-python (remplacer selenium imports par):
# from playwright.sync_api import Page

class Test<FeatureName>:
    def test_<scenario>(self, user_driver):  # ou 'page' pour playwright-python
        user_driver.get(url('<discovered_path>'))
        # Assertions sur le comportement réel de l'app
```

#### `playwright-ts` → TypeScript

```typescript
// tests/<feature>/<feature>.spec.ts
import { test, expect } from '@playwright/test';

test.describe('<FeatureName>', () => {
  test('<scenario>', async ({ page }) => {
    await page.goto('<discovered_url>');
    // assertions
  });
});
```

Config : `playwright.config.ts` à la racine avec `baseURL` = `TEST_BASE_URL`.

#### `cypress` → JavaScript

```javascript
// cypress/e2e/<feature>/<feature>.cy.js
describe('<FeatureName>', () => {
  it('<scenario>', () => {
    cy.visit('<discovered_path>');
    cy.get('<real_selector>').should('<assertion>');
  });
});
```

Config : `cypress.config.js` à la racine avec `baseUrl` = `TEST_BASE_URL`.
Page Objects → `cypress/support/pages/<page>.js`.

#### `robot` → Robot Framework

```robot
*** Settings ***
Library    SeleniumLibrary
Resource   ../resources/<page>.resource

*** Test Cases ***
<Scenario Name>
    Open Browser    ${BASE_URL}<path>    ${BROWSER}
    <Keyword depuis resource>
    Close Browser
```

Resources (Page Objects) → `tests/resources/<page>.resource`.
Variables → `tests/variables/variables.robot` avec `${BASE_URL}`, `${BROWSER}`.

### Règles communes à tous les frameworks

- Sélecteurs uniquement depuis les fichiers Page Object / resource — jamais inline dans les tests
- Nommer les tests selon le comportement attendu, pas l'implémentation
- Assertions sur le résultat réel pour cette app, pas "page loads"

### Security tests — un fichier par formulaire découvert

Générer dans le format du framework choisi. Exemple Python (selenium/playwright-python) :

```python
# tests/security/test_security_<form_name>.py
import pytest
from tests.utils.security_checks import check_no_sql_error_leak, check_reflected_input_escaped
from tests.utils.helpers import url
PATH   = '<discovered_path>'
INPUT  = ('<by_strategy>', '<discovered_field>')
SUBMIT = ('css selector', '<actual_submit_selector>')

@pytest.mark.security
class TestSecurity<FormName>:
    def test_01_no_sql_error_leak(self, user_driver):
        check_no_sql_error_leak(user_driver, INPUT, SUBMIT, url_to_load=url(PATH))
    def test_02_reflected_input_escaped(self, user_driver):
        check_reflected_input_escaped(user_driver, INPUT, SUBMIT, url_to_load=url(PATH))
```

Cypress :
```javascript
// cypress/e2e/security/security_<form_name>.cy.js
describe('Security — <form_name>', () => {
  it('no SQL error leaked', () => { cy.visit('<path>'); cy.get('<input>').type("' OR 1=1 --"); cy.get('<submit>').click(); cy.get('body').should('not.contain', 'SQL'); });
  it('XSS input reflected escaped', () => { cy.visit('<path>'); cy.get('<input>').type('<script>alert(1)</script>'); cy.get('<submit>').click(); cy.get('body').invoke('html').should('not.contain', '<script>'); });
});
```

Skip si aucun champ texte libre — noter pourquoi en commentaire.

## Step 4 — Run + auto-fix loop

Lancer selon le framework choisi :

```bash
# selenium / playwright-python
pytest --headed --tb=short 2>&1 | tee /tmp/pytest_output.txt

# playwright-ts
npx playwright test --headed 2>&1 | tee /tmp/pytest_output.txt

# cypress
npx cypress run --headed 2>&1 | tee /tmp/pytest_output.txt

# robot
robot --variable BROWSER:chrome tests/ 2>&1 | tee /tmp/pytest_output.txt
```

`bootstrap.py` auto-installe les dépendances manquantes pour Python. Pour JS/TS : vérifier `node_modules/` et lancer `npm install` si absent.

### Diagnose each failure and fix immediately:

**Test is wrong** (bad selector, wrong URL, wrong assertion) → fix the Page Object / resource file, re-run le test seul :
```bash
# selenium/playwright-python
pytest --headed tests/<module>::<TestClass>::<test_name> --tb=short
# playwright-ts
npx playwright test tests/<feature>/<test>.spec.ts --headed
# cypress
npx cypress run --spec "cypress/e2e/<feature>/<test>.cy.js" --headed
# robot
robot tests/<feature>/<test>.robot
```

**App is broken** (real bug — missing header, broken form, wrong redirect) → this is a finding, NOT a test fix. Keep the test, flag it in the report.

**Fixture/config issue** (wrong `BASE_URL`, missing `.env.test` value, wrong admin path) → fix `.env.test` or `conftest.py`, re-run.

**Selector drifted** → update the Page Object file with the real current selector — never hardcode selectors in test files :
- selenium/playwright-python → `tests/pages/*.py`
- playwright-ts → `tests/pages/*.ts`
- cypress → `cypress/support/pages/*.js`
- robot → `tests/resources/*.resource`

### Fix iteration rules:

- Fix up to **3 consecutive failures** on the same test before marking it "needs human review"
- After each fix: re-run the fixed test alone, then run the full suite once all fixes are done
- Max **3 full suite iterations** total — remaining failures after 3 rounds = real findings
- Never delete a failing test to make the suite green
- Never touch security test assertions — a security test failure = real vulnerability, report it

### Auto-fixable vs. real finding:

| Symptom | Auto-fix | Report as finding |
|---|---|---|
| Wrong selector in test | ✅ Fix Page Object (`.py`/`.ts`/`.js`/`.resource`) | — |
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
6. **Pass count / total**, lien vers le rapport HTML :
   - selenium/playwright-python → `tests/report.html`
   - playwright-ts → `playwright-report/index.html`
   - cypress → `cypress/results/` (ou Mochawesome si configuré)
   - robot → `results/report.html`

Never say "tests passed" without checking the actual exit code — pytest exits 0 even with skips, and a wall of skips hiding coverage gaps is itself a finding.

## Step 6 (auto) — Génération CI/CD

Après le rapport final, proposer automatiquement de générer le workflow CI adapté au framework et à la plateforme du projet :

Détecter la plateforme CI : chercher `.github/workflows/` (GitHub Actions), `.gitlab-ci.yml` (GitLab), `Jenkinsfile`, `bitbucket-pipelines.yml`, `.circleci/`. Si rien trouvé → proposer GitHub Actions par défaut.

Générer selon `TEST_FRAMEWORK` :

**GitHub Actions — selenium/playwright-python :**
```yaml
# .github/workflows/e2e.yml
name: E2E Tests
on: [push, pull_request]
jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: '3.11' }
      - run: pip install -r tests/requirements.txt
      - run: |
          # Démarrer l'app (adapter à ce projet)
          <start_command_detected_from_code> &
          sleep 5
      - run: pytest --tb=short -q
        env:
          TEST_BASE_URL: http://localhost:<port>
          TEST_HEADLESS: "1"
```

**GitHub Actions — playwright-ts :**
```yaml
      - uses: actions/setup-node@v4
      - run: npm ci && npx playwright install --with-deps
      - run: npx playwright test
```

**GitHub Actions — cypress :**
```yaml
      - uses: cypress-io/github-action@v6
        with: { start: <start_command>, wait-on: 'http://localhost:<port>' }
```

**GitHub Actions — robot :**
```yaml
      - run: pip install robotframework robotframework-seleniumlibrary
      - run: robot --outputdir results tests/
      - uses: actions/upload-artifact@v4
        with: { name: robot-results, path: results/ }
```

Détecter `<start_command>` et `<port>` depuis les scripts `package.json`, `Makefile`, `docker-compose.yml`, ou `CLAUDE.md`. Si introuvable → laisser un placeholder commenté à remplir.

## Re-running after code changes

Re-running `/e2e-audit` is idempotent for re-discovery (routes/forms re-scanned), but it won't blindly overwrite hand-edited test files — diff before overwriting anything that already has non-template content, and ask before replacing custom edits.
