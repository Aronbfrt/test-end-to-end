---
description: Initialize E2E test structure (pytest + Selenium) step by step. Guided setup — adapts to the project's actual stack, routes, and conventions. Use /e2e-audit for fully automatic zero-input setup.
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

## Step 1 — Read the project before asking anything

Before the first question, silently read:
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

## Step 3 — Bootstrap infra (infrastructure only)

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

**Ne jamais copier** : `auth/`, `admin/`, `admin_clients/`, `checkout/`, `contact/`, `home/` — générés seulement si la feature existe.

## Step 4 — Adapter l'infra aux conventions du projet

### `tests/utils/helpers.py`
- `BASE_URL` → valeur depuis `TEST_BASE_URL` dans `.env.test`
- `login()` → adapter `login_path` + sélecteurs de champs avec les vrais noms trouvés dans le HTML (pas `name=email` par défaut)

### `tests/utils/checks.py`
- `LOAD_TIME_BUDGET_MS` / `MAX_IMAGE_BYTES` → budgets réalistes pour ce stack

### `tests/pages/`
- Vider les fichiers placeholder et remplir avec les vrais sélecteurs trouvés dans le HTML/templates
- Nommer les classes selon la convention du projet (camelCase si le projet est camelCase)
- Un fichier par groupe de pages logiquement liées

### `tests/conftest.py`
- `TEST_ADMIN_DASHBOARD_PATH` → chemin réel si admin trouvé, sinon laisser vide (la fixture sera skippée)
- `TEST_AUTH_URL_HINTS` → sous-chaînes de l'URL de login de ce projet (`login,signin,auth`…)
- Credentials dans `.env.test` — jamais en dur dans conftest.py

## Step 5 — Générer les dossiers domaine (adaptatif)

Créer **uniquement** les dossiers correspondant aux features réellement trouvées :

| Feature trouvée | Dossier créé |
|---|---|
| Pages publiques | `tests/public/` (toujours, déjà copié) |
| Formulaire de contact | `tests/contact/` |
| Login/register | `tests/auth/` |
| Zone admin | `tests/admin/` |
| Entité CRUD (products, orders…) | `tests/admin_<entité>/` |
| Checkout/paiement | `tests/checkout/` |
| Feature spécifique au projet | `tests/<nom_feature>/` |

Pour chaque dossier créé :
- Nom de la classe de test = ce qu'elle teste (`TestProductCatalog`, pas `TestAdmin`)
- Sélecteurs uniquement depuis `tests/pages/`, jamais inline
- Assertions sur le vrai comportement attendu pour ce projet

## Step 6 — Vérification

```bash
pytest tests/public tests/seo -v --headed
```

Corriger ce qui échoue (mauvaise URL, sélecteur absent) avant de passer à la suite.

## Step 7 — CI (optionnel)

```bash
mkdir -p .github/workflows
cp tests/ci-e2e-tests.yml .github/workflows/e2e-tests.yml
```
Adapter le step "Start app" à la commande réelle du projet.

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
pytest                        # tout, headless
pytest --headed               # Chrome visible
pytest -m smoke               # chemin critique seulement
pytest tests/auth/ -v         # un dossier
pytest --env=staging          # contre TEST_BASE_URL_STAGING
```
