---
description: Initialize E2E test structure step by step. Guided setup with framework choice (Selenium/Playwright/Cypress/Robot), adapts to the project's stack, routes, and conventions. Use /e2e-audit for fully automatic zero-input setup.
---

# /e2e-init

Guided E2E test setup. Asks one question at a time, reads the project's real code, and produces a test suite that mirrors the project's actual structure — not a generic template.

Use `/e2e-audit` instead if you want everything automatic (zero questions, zero manual input).

## Step 0 — Onboarding (première fois uniquement)

**Vérifier d'abord :** si `.env.test` contient `TEST_FRAMEWORK=`, sauter directement au Step 1. Si des réponses sont déjà dans le prompt, ne pas reposer ces questions.

Poser **4 à 5 questions** sous forme de liste numérotée avec propositions. Adapter selon ce qui est déjà connu.

---

**1. Quel framework de test veux-tu utiliser ?**
> a) Selenium + pytest (Python) — universel, tout backend
> b) Playwright Python — moderne, async, snapshots
> c) Playwright TypeScript — si projet JS/TS
> d) Cypress — si projet React/Vue/Next.js/Nuxt
> e) Robot Framework — style keyword/acceptance testing
> f) Je fais confiance au plugin (détection auto)

**2. Tu veux voir les tests s'exécuter en direct ou en arrière-plan ?**
> a) Headless — invisible, rapide, CI-ready (défaut)
> b) Visible (headed) — voir Chrome s'exécuter en direct

**3. Quelle est l'URL de ton environnement de dev ?**
*(skip si trouvable dans `.env`, scripts `package.json`, ou déjà dit dans le prompt)*
> Répondre librement : `http://localhost:3000`

**4. Quelles catégories de tests veux-tu générer ?**
> a) Tout (fonctionnel + SEO + sécurité + accessibilité + performance + responsive)
> b) Fonctionnel seulement
> c) Sécurité + fonctionnel
> d) Choix libre — écrire les catégories

**5. Y a-t-il des zones protégées dans l'app (login, admin) ?** *(skip si détectable depuis le code)*
> a) Oui, login seulement
> b) Oui, login + espace admin séparé
> c) Non, tout est public

---

Écrire dans `.env.test` après les réponses :
```
TEST_FRAMEWORK=<selenium|playwright-python|playwright-ts|cypress|robot>
TEST_HEADLESS=<1 ou 0>
TEST_BASE_URL=<url>
```

| Choix | Fichiers générés | Runner |
|---|---|---|
| `selenium` | `tests/**/*.py` + conftest.py | `pytest` |
| `playwright-python` | `tests/**/*.py` + conftest.py | `pytest-playwright` |
| `playwright-ts` | `tests/**/*.spec.ts` + playwright.config.ts | `npx playwright test` |
| `cypress` | `cypress/e2e/**/*.cy.js` + cypress.config.js | `npx cypress run` |
| `robot` | `tests/**/*.robot` + resources | `robot` |

## Step 1 — Read the project silently (après Step 0)

Après les réponses du Step 0, lire le projet sans poser de question :
- Stack marker files (`composer.json`, `package.json`, `manage.py`, `pom.xml`, `go.mod`…) → detect language + framework
- 3–5 source files to detect naming conventions (camelCase vs snake_case, class vs function style)
- Existing test files if any → detect patterns already in use (Page Objects, helpers, fixtures, assertion style)
- Templates/views → detect routes, forms, field names

Detect stack using the same table as `/e2e-audit` Step 2a. Don't ask the user what their stack is if you can read it.

## Step 2 — One question at a time

Ask only what can't be read from the code. Each answer unlocks the next step. Stop asking once you have enough to generate.

**Questions (only ask if not determinable from code):**

1. "Quelle est l'URL de ton environnement de dev ?" → sets `TEST_BASE_URL` in `.env.test`
2. "Y a-t-il une zone admin / back-office ?" → if yes, ask for the dashboard path and credentials
3. "Y a-t-il un système de paiement (Stripe, PayPal, autre) ?" → if yes, detect checkout routes from code

Do not ask about routes, forms, or field names — read them from the code.

## Step 3 — Bootstrap infra selon le framework choisi

Lire `TEST_FRAMEWORK` dans `.env.test` (défini au Step 0) :

**selenium / playwright-python :**
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
```

**playwright-ts :**
```bash
mkdir -p tests
cat > playwright.config.ts << 'EOF'
import { defineConfig } from '@playwright/test';
export default defineConfig({ use: { baseURL: process.env.TEST_BASE_URL || 'http://localhost:3000' } });
EOF
npm install -D @playwright/test && npx playwright install
```

**cypress :**
```bash
mkdir -p cypress/e2e cypress/support/pages cypress/fixtures
cat > cypress.config.js << 'EOF'
const { defineConfig } = require('cypress');
module.exports = defineConfig({ e2e: { baseUrl: process.env.TEST_BASE_URL || 'http://localhost:3000', specPattern: 'cypress/e2e/**/*.cy.js' } });
EOF
npm install -D cypress
```

**robot :**
```bash
mkdir -p tests/resources tests/variables
echo -e "*** Variables ***\n\${BASE_URL}    http://localhost:3000\n\${BROWSER}    chrome" > tests/variables/variables.robot
pip install robotframework robotframework-seleniumlibrary
```

**Ne jamais créer** : `auth/`, `admin/`, `checkout/`, `contact/`, `home/` — générés seulement si la feature existe.

## Step 4 — Adapter l'infra aux conventions du projet

Adapter selon `TEST_FRAMEWORK` :

### selenium / playwright-python
- `tests/utils/helpers.py` → `BASE_URL` depuis `TEST_BASE_URL`, `login()` avec les vrais sélecteurs trouvés dans le HTML
- `tests/utils/checks.py` → budgets `LOAD_TIME_BUDGET_MS` / `MAX_IMAGE_BYTES` réalistes pour ce stack
- `tests/pages/*.py` → vider les placeholders, remplir avec les vrais sélecteurs. Un fichier par groupe de pages.
- `tests/conftest.py` → `TEST_ADMIN_DASHBOARD_PATH` (réel ou vide), `TEST_AUTH_URL_HINTS`, credentials depuis `.env.test`

### playwright-ts
- `playwright.config.ts` → `baseURL` depuis `TEST_BASE_URL`, ajouter `use.adminPath` si admin trouvé
- `tests/pages/*.ts` → interfaces/classes avec les vrais sélecteurs. Un fichier par groupe de pages.
- Fixtures dans `tests/fixtures.ts` si auth nécessaire

### cypress
- `cypress.config.js` → `baseUrl` depuis `TEST_BASE_URL`, `env.adminPath` si admin trouvé
- `cypress/support/pages/*.js` → objets avec les vrais sélecteurs. Un fichier par groupe de pages.
- `cypress/support/commands.js` → commandes custom (login, etc.) avec les vrais champs HTML

### robot
- `tests/variables/variables.robot` → `${BASE_URL}`, `${BROWSER}`, `${ADMIN_PATH}` si admin trouvé
- `tests/resources/*.resource` → Keywords avec les vrais sélecteurs. Un fichier par groupe de pages.
- Credentials dans `.env.test` — jamais en dur dans les fichiers robot

## Step 5 — Générer les dossiers domaine (adaptatif)

Créer **uniquement** les dossiers correspondant aux features réellement trouvées. Chemins selon `TEST_FRAMEWORK` :

| Feature | Python | Playwright TS | Cypress | Robot |
|---|---|---|---|---|
| Pages publiques | `tests/public/` | `tests/public/` | `cypress/e2e/public/` | `tests/public/` |
| Contact | `tests/contact/` | `tests/contact/` | `cypress/e2e/contact/` | `tests/contact/` |
| Auth | `tests/auth/` | `tests/auth/` | `cypress/e2e/auth/` | `tests/auth/` |
| Admin | `tests/admin/` | `tests/admin/` | `cypress/e2e/admin/` | `tests/admin/` |
| CRUD entité | `tests/admin_<e>/` | `tests/admin_<e>/` | `cypress/e2e/admin_<e>/` | `tests/admin_<e>/` |
| Checkout | `tests/checkout/` | `tests/checkout/` | `cypress/e2e/checkout/` | `tests/checkout/` |
| Feature custom | `tests/<feat>/` | `tests/<feat>/` | `cypress/e2e/<feat>/` | `tests/<feat>/` |

Pour chaque dossier créé :
- Sélecteurs uniquement depuis le Page Object du framework — jamais inline dans les tests
- Assertions sur le comportement réel attendu pour ce projet, pas "page loads"

## Step 6 — Vérification

Lancer les tests publics + SEO selon `TEST_FRAMEWORK` :

```bash
# selenium / playwright-python
pytest tests/public tests/seo -v --headed

# playwright-ts
npx playwright test tests/public/ tests/seo/ --headed

# cypress
npx cypress run --spec "cypress/e2e/public/**,cypress/e2e/seo/**" --headed

# robot
robot tests/public/ tests/seo/
```

Corriger ce qui échoue (mauvaise URL, sélecteur absent) avant de passer à la suite.

## Step 7 — CI/CD (optionnel)

Proposer de générer un workflow CI adapté au framework et à la plateforme détectée (même logique que /e2e-audit Step 6). Détecter plateforme depuis `.github/workflows/`, `.gitlab-ci.yml`, `Jenkinsfile` — sinon proposer GitHub Actions.

Générer le fichier adapté au `TEST_FRAMEWORK` choisi au Step 0. Détecter `<start_command>` et `<port>` depuis `package.json`, `Makefile`, ou `CLAUDE.md`.

## Variables `.env.test`

```env
TEST_BASE_URL=http://localhost:8000
TEST_ADMIN_DASHBOARD_PATH=           # laisser vide si pas d'admin
TEST_AUTH_URL_HINTS=login,signin,auth
TEST_ADMIN_EMAIL=admin@example.com
TEST_ADMIN_PASS=password
TEST_USER_EMAIL=user@example.com
TEST_USER_PASS=password
TEST_HEADLESS=1
TEST_BROWSER=chrome
TEST_SCREENSHOTS=tests/screenshots
```

## Commandes utiles

```bash
# selenium / playwright-python
pytest                        # tout, headless
pytest --headed               # Chrome visible
pytest -m smoke               # chemin critique seulement
pytest tests/auth/ -v         # un dossier
pytest --env=staging          # contre TEST_BASE_URL_STAGING

# playwright-ts
npx playwright test           # tout, headless
npx playwright test --headed  # visible
npx playwright test --ui      # interface graphique

# cypress
npx cypress run               # tout, headless
npx cypress open              # interface graphique interactive

# robot
robot tests/                  # tout
robot --variable BROWSER:chrome tests/   # Chrome visible
```
