<p align="center"><img src="docs/assets/logo.png" alt="Test End-to-End" width="640"></p>

<p align="center"><b>C'est la révolution des tests end-to-end.</b></p>

<p align="center">Générateur de tests E2E zéro effort manuel — Selenium · Playwright · Cypress · Robot Framework, n'importe quel langage backend, tout découvert depuis le code lui-même.</p>

<p align="center"><img src="docs/assets/demo.gif" alt="Démo terminal" width="560"></p>

---

## Le problème que ça résout

Écrire une suite de tests end-to-end correcte prend des jours : trouver toutes les routes, écrire les sélecteurs, gérer l'auth, penser au SEO, à la sécurité, à l'accessibilité, au responsive — et la maintenir à jour à chaque changement de code. La plupart des projets n'en ont juste pas, ou une poignée de tests qui datent d'il y a six mois.

`test-end-to-end` lit le code du projet et génère une suite qui s'adapte à ce qui existe réellement — pas un template générique imposé. Un projet Laravel reçoit des tests Laravel. Un projet Next.js reçoit des tests Next.js. Un projet sans admin ne reçoit pas de dossier `tests/admin/` vide.

## Comment ça marche

1. **Lecture des conventions** — avant de générer quoi que ce soit, lit 3–5 fichiers sources pour détecter le style du projet (naming, patterns de test existants, structure des dossiers).
2. **Découverte** — analyse statique (pas de crawl live) sur 14+ stacks : PHP vanilla · Laravel · Symfony · Spring Boot · Next.js · Nuxt · Vue · Svelte · Angular · Django · Flask · FastAPI · Rails · Go · Rust · Elixir. Extrait les vraies routes, les vrais champs de formulaire, les vraies entités.
3. **Migration** — si des tests existent déjà (Jest, Cypress, Playwright, Robot, PHPUnit, RSpec, JUnit, Gherkin…), les convertit dans le format du framework choisi en préservant l'intention, le style, et les patterns (Page Objects, helpers, fixtures) de la personne.
4. **Génération adaptative** — crée uniquement les dossiers qui correspondent aux features trouvées. Pas d'`auth/` sans login. Pas d'`admin/` sans back-office. Pas de `checkout/` sans paiement.
5. **Exécution + auto-fix** — lance le runner du framework choisi en visible (`pytest --headed` / `npx playwright test --headed` / `npx cypress run --headed` / `robot`), analyse chaque échec, corrige et relance en boucle jusqu'à 3 rounds. Ce qui reste rouge après 3 rounds = vrai bug dans l'app.
6. **Rapport** — dashboard custom : groupes par domaine, screenshot/replay GIF sur les échecs, badge sécu 🔒, colonnes visuel/stabilité/sélecteur.
7. **Idempotent** — relancer `/e2e-audit` ajoute les nouvelles routes sans écraser les tests existants.

## Pour qui

Quiconque utilise Claude Code sur un projet web (peu importe le langage backend) et veut une vraie couverture E2E sans y passer une semaine : développeur solo, petite équipe sans QA dédiée, ou juste pour avoir un garde-fou avant chaque déploiement.

---

## Installation

**Étape 1** — ajouter la marketplace (attendre la confirmation avant de continuer) :

```
/plugin marketplace add https://github.com/Aronbfrt/test-end-to-end
```

**Étape 2** — installer le plugin :

```
/plugin install test-end-to-end@test-end-to-end
```

> **Note :** la forme courte `Aronbfrt/test-end-to-end` utilise SSH et échoue sans clé GitHub configurée. L'URL HTTPS complète fonctionne sans configuration supplémentaire.

## Commandes

| Commande | Action |
|---|---|
| `/e2e-init` | Setup guidé — onboarding framework, bootstrap adaptatif, routes/forms remplis étape par étape |
| `/e2e-audit` | Audit automatique complet — onboarding framework, découverte statique 14+ stacks, génère tests + API headless + sécurité + SEO + a11y + perf + responsive, lance, corrige en boucle, génère CI/CD. Idempotent. |
| `/e2e-coverage` | Carte de couverture — quelles routes ont des tests, lesquelles n'en ont pas. % global + formulaires sans test sécurité. |
| `/e2e-update` | Sync tests après changements code — ajoute tests pour nouvelles routes, flag xfail les routes supprimées, met à jour les sélecteurs. Jamais de suppression. |

Déclencheurs langage naturel : "teste-moi le site", "audit le site", "test complet" → `/e2e-audit` · "couverture des tests" → `/e2e-coverage` · "mettre à jour les tests" → `/e2e-update`.

## Lancer les tests

Selon le framework choisi au premier setup (`TEST_FRAMEWORK` dans `.env.test`) :

```bash
# Selenium + pytest / Playwright Python
pytest                         # headless
pytest --headed                # Chrome visible
pytest --headed -x             # stop au premier échec
pytest -m smoke                # tests critiques seulement
pytest tests/seo/              # un dossier

# Playwright TypeScript
npx playwright test            # headless
npx playwright test --headed   # visible
npx playwright test --ui       # interface graphique

# Cypress
npx cypress run                # headless
npx cypress open               # interface graphique interactive

# Robot Framework
robot tests/                   # headless
robot --variable BROWSER:chrome tests/   # Chrome visible
```

## Migration automatique des tests existants

Tu as déjà des tests ? `/e2e-audit` les détecte et les convertit automatiquement dans le format du framework choisi (Selenium, Playwright, Cypress, ou Robot) :

| Format source | Converti dans le format du framework choisi |
|---|---|
| Jest / Vitest | describe/test → format cible |
| Cypress existant | conservé si framework = Cypress, sinon converti |
| Playwright existant | conservé si framework = Playwright, sinon converti |
| WebdriverIO | converti vers le format cible |
| **Robot Framework** (`.robot`) | conservé si framework = Robot, sinon converti |
| **Cucumber / Gherkin** (`.feature`) | chaque `Scenario` → test unitaire dans le format cible |
| PHPUnit | converti vers le format cible |
| JUnit / TestNG (Java) | converti vers le format cible |
| NUnit / xUnit / MSTest (C#) | converti vers le format cible |
| RSpec / Minitest (Ruby) | converti vers le format cible |
| Go test (`*_test.go`) | converti vers le format cible |
| Selenium IDE (`.side`) | converti vers le format cible |

- Sélecteurs extraits dans le Page Object du framework (jamais inline dans les tests)
- L'intention du test est préservée exactement — seule la syntaxe change
- Chaque test converti est marqué `# converted from` / `// converted from` / `[Documentation] converted from`
- Le fichier original est supprimé après conversion réussie

## Auto-fix en direct

`/e2e-audit` ne s'arrête pas après la première run — il corrige les échecs et relance en boucle, **Chrome ouvert en visible** pour voir chaque test s'exécuter en direct :

1. Lance le runner du framework choisi en mode visible sur la suite complète
2. Pour chaque test qui échoue, analyse le rapport et corrige immédiatement :
   - Mauvais sélecteur → met à jour le Page Object (`.py` / `.ts` / `.js` / `.resource`)
   - Mauvaise URL dans le test → corrige le path
   - Mauvaise config (`.env.test`, `BASE_URL`) → corrige et relance
3. Relance le test corrigé seul pour valider le fix
4. Recommence jusqu'à 3 fois au maximum
5. Ce qui reste rouge après 3 rounds = **vrai bug dans l'app** → reporté comme finding, jamais supprimé

Les tests sécu ne sont **jamais modifiés** — un échec sécu = vulnérabilité réelle, toujours signalé.

---

## Le pipeline

<p align="center"><img src="docs/assets/devops-pipeline.png" alt="Pipeline DevOps" width="900"></p>

---

## 4 choses que personne d'autre ne fait

- **🎬 Replay animé des échecs** — pas un screenshot du moment où ça plante, un GIF des dernières actions (clics + navigations) qui ont mené au crash. Capturé en silence, assemblé seulement si ça apporte une vraie info (pas de "replay" figé si la page n'a pas bougé).
- **👁 Régression visuelle** — chaque test compare son screenshot à une baseline, pass ou fail. Un test peut être 100% fonctionnellement vert et avoir quand même un bouton qui a bougé ou un header devenu invisible — aucun `assert` ne voit ça, ce mécanisme oui.
- **🎲 Détection de tests instables** — historique léger sur les derniers runs, flag les tests qui se contredisent d'une fois à l'autre. Le signal que `pytest-rerunfailures` masque en se contentant de réessayer.
- **🩹 Sélecteurs auto-réparants** — narrow et jamais silencieux : un seul repli (id↔name↔data-testid), jamais d'heuristique floue qui risquerait d'interagir avec le mauvais élément. Si ça répare, ça le crie dans le rapport.

## Ce que tu obtiens

- **Page Object Model** — sélecteurs dans `tests/pages/`, jamais en dur dans un test
- **Dossiers plats par domaine** — `tests/auth/`, `tests/admin/`, `tests/checkout/`... une feature = un endroit
- **Navigateurs session-scoped** — un navigateur par rôle pour toute la run, scale à 1000+ tests
- **SEO complet** — title/meta/canonical (+ https)/h1/hiérarchie de titres/alt/lang/viewport/Open Graph/noindex/structured data/robots.txt/sitemap.xml, chaque échec explique pourquoi ça compte
- **Sécurité complète, non-destructive** — fuite erreur SQL, échappement input réfléchi, headers sécu (CSP/HSTS/X-Frame-Options...), cookies (Secure/HttpOnly/SameSite), fuite de version serveur, open redirect, listing de répertoire, CORS permissif, chemins sensibles exposés, bannières debug, bypass auth admin, prix manipulable côté client. Jamais destructif, jamais contre la prod.
- **Accessibilité au-delà du scan générique** — lien d'évitement, labels de formulaire, landmarks ARIA, pièges aria-hidden, boutons sans nom accessible
- **Responsive complet** — débordement horizontal multi-breakpoints, cibles tactiles, images qui scalent, taille de police lisible sur mobile
- **Performance au-delà du chargement** — scripts bloquants, poids total de la page, taille du DOM, First Contentful Paint, compression gzip/brotli
- **Rapport HTML enrichi** — échecs avec screenshot/replay + erreurs console embarqués direct dans la ligne, thème sombre, colonnes Catégorie/Visuel/Stabilité/Sélecteur (sécu = badge rouge 🔒)
- **Zéro install** — pour Selenium/Playwright Python : `tests/run.sh` installe automatiquement les paquets pip manquants. Pour Playwright TS/Cypress : `npm install` suffit. Pour Robot Framework : `pip install robotframework robotframework-seleniumlibrary`.
- **N'importe quelle stack** — PHP, Java/Spring, Next.js, Django, Flask, Rails, Go, Rust, Elixir — la découverte de routes s'adapte selon le fichier marqueur (`composer.json`, `pom.xml`, `manage.py`...)

Voir `templates/e2e/README.md` pour la référence complète de structure une fois installé dans un projet.

---

## Le rapport

<p align="center"><img src="docs/report-screenshot.png" alt="Rapport E2E — thème sombre, colonnes Catégorie/Visuel/Stabilité/Sélecteur" width="700"></p>

---

## Contributeurs

- [Aron Beaufort](https://github.com/Aronbfrt) — créateur & mainteneur

PR bienvenues — voir `templates/e2e/README.md` pour les conventions à suivre (Page Object Model, dossiers plats par domaine, messages d'assertion qui expliquent le pourquoi, pas juste le quoi).
