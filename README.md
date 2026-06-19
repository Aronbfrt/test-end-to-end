<p align="center">
  <img src="docs/assets/logo.svg" alt="test-end-to-end" width="480" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-2.0.0-6366f1?style=flat-square" alt="version" />
  <img src="https://img.shields.io/badge/TypeScript-5.4-3178c6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/MCP-natif-5046e4?style=flat-square&logoColor=white" alt="MCP" />
  <img src="https://img.shields.io/badge/Playwright-testé-2EAD33?style=flat-square&logoColor=white" alt="Playwright" />
  <img src="https://img.shields.io/badge/build-passing-22c55e?style=flat-square" alt="build" />
  <img src="https://img.shields.io/badge/licence-MIT-f59e0b?style=flat-square" alt="licence" />
</p>

<h3 align="center">La fabrique QA cognitive autonome pour Claude Code — 13 agents spécialisés.</h3>

<p align="center">
  Analyse l'AST de votre projet, génère des tests Playwright, les exécute, triage les crashs, corrige les bugs<br>
  et ouvre la PR — sans écrire une seule ligne de configuration ni de test.<br>
  Compatible Node.js, TypeScript, PHP et Python. Zéro setup requis.
</p>

<p align="center">
  <a href="#prérequis">Prérequis</a> ·
  <a href="#installation">Installation</a> ·
  <a href="#démarrage-rapide">Démarrage rapide</a> ·
  <a href="#commandes">Commandes</a> ·
  <a href="#outils-mcp">Outils MCP</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#dashboard">Dashboard</a> ·
  <a href="#intégrations">Intégrations</a>
</p>

---

## Comment ça marche

```mermaid
flowchart TD
    P(["📂 Votre projet"]) --> O

    O["🧠 Orchestrateur\nZero-Token Bypass · SHA-256\nOllama local → Anthropic SDK"]

    O --> SC["🔍 Scout\nAST scan · routes · forms"]
    SC --> AR["✍️ Artisan\ngénération specs Playwright"]
    AR --> RU["▶️ Runner\nexécution Playwright"]

    RU -- "✓ pass" --> CO["📈 Coverage\ncarte % routes"]
    RU -- "✗ crash" --> CR["🔬 Coroner\ntriage · verdict LLM"]
    CR -- "BACKEND_BUG" --> GH["🩹 Ghostwriter\npatch + PR dry-run"]

    O --> PA["Agents parallèles\nChaosMonkey · ArchPolice · Sentinel · Dependabot"]

    CO --> DA["📊 Dashboard :4242\n8 onglets · WebSocket · FinOps"]
    GH --> DA
    PA --> DA
```

---

## Prérequis

| Outil | Version min | Utilité |
|---|---|---|
| Node.js | ≥ 18.0.0 | Runtime — ESM + fetch natif requis |
| npm | ≥ 9.0.0 | Gestionnaire de paquets |
| Claude Code | latest | Hôte du plugin |
| Playwright | auto-installé | Exécuteur de tests navigateur |
| GitHub CLI `gh` | quelconque | Audit PR Sentinel + création PR Ghostwriter |
| Ollama | optionnel | Zero-Token Bypass pour l'inférence locale |

---

## Installation

```bash
git clone https://github.com/Aronbfrt/test-end-to-end
cd test-end-to-end
npm install        # installe Playwright + toutes les dépendances
npm run build      # compile TypeScript → dist/
```

> Le script `scripts/setup.sh` fait la même chose et configure aussi l'environnement : `bash scripts/setup.sh`

Ajouter dans `.claude/settings.json` :

```json
{
  "plugins": ["./chemin/vers/test-end-to-end"]
}
```

---

## Démarrage rapide

```bash
# 1. Analyser le projet et générer les tests
node dist/index.js init /votre/projet
# → Détecte le stack, extrait routes + forms, écrit tests/*.spec.ts

# 2. Lancer l'audit complet
node dist/index.js audit /votre/projet
# → Joue Playwright, triage les crashs, ouvre une PR de patch si bug confirmé

# 3. Ouvrir le dashboard live
npm run dashboard
# → http://localhost:4242  (configurable via E2E_PORT dans .env)
```

---

## Commandes

| Commande | Ce qu'elle fait | Sortie principale |
|---|---|---|
| `e2e-init` | Scan AST, détecte routes/forms, génère les specs Playwright | `tests/*.spec.ts`, `.e2e-work/last-routes.json` |
| `e2e-audit` | Pipeline complet : scan → run → triage → patch | Score Confidence Index, rapports de crash |
| `e2e-coverage` | Carte de couverture routes/forms avec % | Tableau terminal + `.e2e-work/coverage.html` |
| `e2e-update` | Sync intelligente des tests après modifications, protège les tests manuels | Specs mises à jour, résumé du diff |
| `e2e-repair` | Triage un crash + patch dry-run via Ghostwriter | `.e2e-work/patches-pending/` |
| `e2e-sentinel` | Audit OWASP des PRs ouvertes via GitHub CLI | `APPROVE` / `REJECT` / `COMMENT` avec findings |
| `e2e-chaos` | Génère des tests réseau chaotiques (LATENCY, OFFLINE, CORRUPT…) | Fichiers `chaos_*.spec.ts` |
| `e2e-arch` | Analyse statique : complexité, couplage, `any`, longueur de fichiers | `arch-report.md`, score 0–100 |
| `e2e-diff` | Cible le scan sur les fichiers modifiés (git diff HEAD + staged) | Specs pour routes nouvelles/modifiées |
| `e2e-shadow` | Reverse Testing zéro-prompt — 4 personas (Frustré, Attaquant, Chaos Réseau, Acheteur Impulsif) | `tests/shadow/<persona>-<route>.spec.ts` |

### Niveaux d'exécution

| Niveau | Ce qui s'active |
|---|---|
| `--level=1` | Scan AST + génération tests + run Playwright. Zéro token si Ollama actif. |
| `--level=2` | Niveau 1 + Vision QA (Coroner analyse les screenshots) + rapport de couverture |
| `--level=3` | Niveau 2 + Ghostwriter (patch auto) + Evolver (auto-amélioration) + Shadow Personas |

### Options

```bash
--level=1|2|3       # Profondeur (défaut : 2)
--dry-run           # Affiche les changements prévus sans écrire les fichiers
--apply             # Ghostwriter : applique les patches sur disque et ouvre la PR
--unsupervised      # Evolver : auto-commit des auto-patches (dangereux)
--chaos             # Injecte des fautes réseau en parallèle du run
--predictive        # Priorise les fichiers à fort taux de churn (historique git 12 mois)
--trace=<id>        # Répare un triage spécifique par son ID
```

### Script de sécurité rapide

```bash
npm run security-fix /votre/projet
# équivalent à : node dist/agents/dependabot.js /votre/projet
# → npm audit, fix LLM, vérification tsc, PR GitHub si GITHUB_TOKEN défini
```

### Appliquer une évolution supervisée

Quand l'Evolver détecte un pattern d'échec, il écrit une proposition dans `.e2e-work/evolutions-pending/` sans toucher au code source. Pour l'appliquer après revue humaine :

```bash
node dist/index.js e2e-evolve-apply .e2e-work/evolutions-pending/1234567890-scout.evolution.json
# → applique le diff, commit git, archive dans evolutions-applied/
```

---

## Outils MCP

Le plugin expose **11 outils MCP natifs** utilisables par Claude Code et tout agent IA compatible MCP.

| Outil MCP | Paramètres clés | Ce qu'il fait |
|---|---|---|
| `e2e_init` | `targetPath`, `level` | Initialise l'écosystème QA : détection stack, amorçage cache, génération tests |
| `e2e_audit` | `targetPath`, `level`, `chaos`, `predictive` | Audit complet : scan → run → triage → patch |
| `e2e_coverage` | `targetPath`, `detail` | Carte de couverture routes/forms, génère `coverage.html` |
| `e2e_update` | `targetPath`, `dryRun`, `level` | Sync tests après changements, protège les tests manuels |
| `e2e_repair` | `targetPath`, `traceId`, `bugReport` | Ghostwriter : patch chirurgical + PR depuis un triage |
| `e2e_shadow` | `targetPath`, `level`, `chaos` | Reverse Testing zéro-prompt — 4 shadow personas |
| `e2e_diff` | `targetPath`, `predictive`, `level` | Cible le run sur le git diff courant |
| `e2e_sentinel` | `targetPath`, `prNumber`, `repo` | Audit OWASP des PRs GitHub (APPROVE / COMMENT / REJECT) |
| `e2e_arch` | `targetPath` | Analyse statique : complexité, couplage, score 0–100 grade A–F |
| `e2e_chaos` | `targetPath`, `scenarios[]` | Génère specs chaos (LATENCY, TIMEOUT, ERROR_50x, OFFLINE, CORRUPT, PARTIAL) |
| `e2e_diagnostics` | — | Retourne l'état de l'orchestrateur, Ollama et le snapshot du cache |

> Tous les outils MCP acceptent les mêmes paramètres que leurs commandes CLI équivalentes.

---

## Architecture

### Pipeline d'exécution

```mermaid
flowchart TD
    CLI(["🖥️ CLI · MCP Tool"]) --> ORCH

    subgraph ORCH["🧠 Orchestrateur"]
        direction LR
        BY["SHA-256\nZero-Token Bypass"]
        OL["Ollama\nlocal"]
        AN["Anthropic SDK"]
        BY -- modifié --> OL
        OL -- complexe --> AN
        BY -- inchangé --> SK(["⚡ Skip"])
    end

    ORCH --> SCAN
    ORCH --> PARA

    subgraph SCAN["📡 Analyse & Génération"]
        direction LR
        SCOUT["Scout\nAST → RouteMap"]
        ARTISAN["Artisan\nSpecs Playwright"]
        UPDATER["Updater\nSync"]
        SCOUT --> ARTISAN --> UPDATER
    end

    subgraph PARA["Agents indépendants"]
        direction LR
        ARCHP["ArchPolice"]
        DEP["Dependabot"]
        SENT["Sentinel\nOWASP"]
        CHAOS["ChaosMonkey"]
        SHADOW["Shadow\n4 Personas"]
    end

    SCAN --> RUN

    subgraph RUN["▶️ Exécution"]
        RUNNER["Runner\nPlaywright"]
    end

    RUN -- "✓ pass" --> COV["Coverage\ncarte %"]
    RUN -- "✗ crash" --> TRI

    subgraph TRI["🔬 Triage"]
        CORONER["Coroner\nVerdict LLM"]
        RGPD["RGPDGuard\nmasquage PII"]
        CORONER --> RGPD
    end

    CORONER -- "BACKEND_BUG" --> FIX

    subgraph FIX["🩹 Correction"]
        GHOST["Ghostwriter\nPatch + PR"]
        QAE["QAEngineer\nRégression"]
        EVOL["Evolver\nsupervisé"]
        GHOST --> QAE
        GHOST --> EVOL
    end

    FIX --> DB
    TRI --> DB
    SCAN --> DB
    PARA --> DB
    COV --> DB

    subgraph DB["📊 Dashboard :4242"]
        direction LR
        WS["WebSocket live\n8 onglets"]
        SQ[("SQLite\nFinOps")]
    end
```

### Les 13 agents

| Agent | Rôle |
|---|---|
| **Scout** | Parsing AST avec `ts-morph` — extrait routes, forms, handlers, détecte le stack (Express, Next.js, PHP, Django…) |
| **Artisan** | Génère des specs Playwright depuis la `RouteMap` — couvre happy path, edge cases, flux auth |
| **Runner** | Exécute Playwright, parse la sortie JSON reporter, écrit `CrashContext` pour chaque échec |
| **Coroner** | Triage les crashs → verdict : `BACKEND_BUG`, `SELECTOR_DRIFT`, `NETWORK_ERROR`, `UNKNOWN` |
| **ChaosMonkey** | Injecte du chaos réseau via `page.route()` : `LATENCY`, `TIMEOUT`, `ERROR_50x`, `OFFLINE`, `CORRUPT`, `PARTIAL` |
| **RGPDGuard** | Masque les PII avant écriture sur disque — JWT, clés API, emails, IBAN, numéros de carte |
| **Sentinel** | Audit OWASP des PRs via `gh` CLI — détecte injections, backdoors, logique d'auth cassée |
| **Coverage** | Carte de couverture routes/forms avec %, met en évidence les endpoints non testés |
| **Updater** | Sync intelligente des tests après changements de routes — protège les tests manuels de l'écrasement |
| **QAEngineer** | Génère des tests de régression après les patches Ghostwriter pour verrouiller le fix |
| **ArchPolice** | Détecte complexité élevée, couplage excessif, `any` dangereux, fichiers surdimensionnés |
| **Ghostwriter** | Corrige les bugs applicatifs + ouvre une PR — dry-run par défaut, `--apply` pour déployer sur disque |
| **Evolver** | Auto-améliore les prompts des agents depuis l'analyse des échecs — supervisé par défaut, propositions dans `.e2e-work/evolutions-pending/` |
| **Dependabot** | `npm audit` → fix analysé par LLM → vérification `tsc --noEmit` → PR |

### Zero-Token Bypass

```mermaid
flowchart LR
    F(["📂 Fichiers\nsource"]) --> H["SHA-256\nempreinte"]
    H --> C[("SQLite\ncache")]
    C -- "identique" --> SK(["⚡ Skipped\n0 token"])
    C -- "différente" --> O{"Ollama\ndispo ?"}
    O -- "oui" --> L(["Inférence locale\ngratuite"])
    O -- "non" --> A(["Anthropic SDK\ntokens"])
    L --> R(["✓ Résultat"])
    A --> R
```

- **SHA-256** calcule l'empreinte de chaque fichier source au premier scan
- **SQLite** (mode WAL) stocke l'état du dernier scan par projet
- Les fichiers non modifiés sont **ignorés entièrement** — zéro token consommé
- **Ollama** prend en charge les tâches légères d'AST et de classification localement
- **Anthropic SDK** réservé au raisonnement sémantique (triage, génération de patches, audit OWASP)
- Résultat : **jusqu'à 90% de réduction de tokens** sur les runs incrémentaux

---

## Dashboard

<p align="center">
  <img src="docs/assets/dashboard-preview.png" alt="Dashboard — vue d'ensemble" width="860" />
</p>

```bash
npm run dashboard
# → http://localhost:4242  (changer le port : E2E_PORT=5000 npm run dashboard)
```

### 8 Onglets

| Onglet | Contenu |
|---|---|
| **Runs** | Historique complet des runs avec Confidence Index (0–100), durée, compteurs pass/fail |
| **Coverage** | Carte de couverture routes et forms — vert/rouge par endpoint, % global |
| **Crashs** | Tous les résultats de triage avec verdict, raisonnement et déclencheur de réparation en un clic |
| **Évolutions** | Propositions Evolver en attente — revue et application via `e2e-evolve-apply` |
| **Sentinel** | Findings OWASP par PR — sévérité, route, recommandation |
| **ArchPolice** | Violations architecture : scores de complexité, matrice de couplage, heatmap taille de fichiers |
| **Intégrations** | Statut live des services connectés (Slack, Jira, OVH…) |
| **FinOps** | Consommation de tokens, CO₂ économisé vs. run complet, delta de coût, compteur masques RGPD |

> Mode sombre · Mises à jour live WebSocket · Confidence Index (0–100) · Zéro CDN externe

---

## Intégrations

Toutes les intégrations sont **optionnelles**. Copier `.env.example` vers `.env` et renseigner uniquement ce qui est utilisé.

### ChatOps

| Intégration | Variables d'environnement | Déclencheur |
|---|---|---|
| Slack | `SLACK_WEBHOOK_URL` | Crash détecté, patch appliqué, résultat sentinel |
| Discord | `DISCORD_WEBHOOK_URL` | Idem |
| Microsoft Teams | `TEAMS_WEBHOOK_URL` | Idem |

### Gestion de projet

| Intégration | Variables d'environnement | Déclencheur |
|---|---|---|
| Jira + Xray | `JIRA_URL`, `JIRA_TOKEN`, `JIRA_USER_EMAIL`, `JIRA_PROJECT_KEY` | Crash → ouvre ticket / Patch → ferme ticket |
| Trello | `TRELLO_API_KEY`, `TRELLO_TOKEN`, `TRELLO_TODO_LIST_ID`, `TRELLO_DONE_LIST_ID` | Crash → carte TODO / Patch → carte DONE |

### Déploiement & hébergement

| Intégration | Variables d'environnement | Déclencheur |
|---|---|---|
| OVHcloud | `OVH_APP_KEY`, `OVH_APP_SECRET`, `OVH_CONSUMER_KEY`, `OVH_PROJECT_ID`, `OVH_SERVICE_NAME` | Déploiement + récupération logs SSH post-crash |
| IONOS | `IONOS_GITHUB_REPO`, `IONOS_GITHUB_TOKEN`, `IONOS_WORKFLOW_FILE`, `IONOS_DEPLOY_BRANCH` | CI/CD via `workflow_dispatch` |
| Hostinger | `HOSTINGER_DEPLOY_WEBHOOK_URL` | Déploiement par webhook HTTP |
| SSH générique | `SSH_HOST`, `SSH_PORT`, `SSH_USER`, `SSH_PRIVATE_KEY` | Récupération logs serveur post-crash |

### GitHub & Paiement

| Intégration | Variables d'environnement | Déclencheur |
|---|---|---|
| GitHub | `GITHUB_TOKEN` | Audit PR Sentinel, PR Ghostwriter, PR Dependabot |
| Stripe (test) | `STRIPE_WEBHOOK_SECRET` | Simulation webhooks paiement en environnement de test |

### Variables système

| Variable | Défaut | Rôle |
|---|---|---|
| `E2E_PORT` | `4321` | Port du dashboard |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Endpoint Ollama personnalisé |
| `DEPENDABOT_MIN_SEVERITY` | `high` | Sévérité minimale pour déclencher un fix : `critical` / `high` / `moderate` / `low` |

---

## Sécurité

- **Ghostwriter est en dry-run par défaut** — les patches ne sont jamais auto-appliqués sur disque sans `--apply`
- **Evolver est supervisé par défaut** — les auto-patches nécessitent une approbation humaine via `e2e-evolve-apply` avant de toucher `src/`
- **Whitelist de commandes SSH** — seuls `tail`, `cat`, `journalctl`, `pm2` sont autorisés ; tout le reste est rejeté au niveau de l'intégration
- **RGPDGuard masque toutes les PII** avant écriture dans `.e2e-work/` — tokens JWT, clés API, emails, IBAN, numéros de carte
- **Aucune donnée sensible loggée sur stdout** — clés API et credentials SSH n'apparaissent jamais dans la console
- **Rate limiter sur tous les appels Anthropic SDK** — 5 requêtes simultanées max, rechargement token-bucket à 1/sec

---

## Répertoire de travail `.e2e-work/`

Tous les artefacts générés sont isolés dans `.e2e-work/` à la racine du projet cible — jamais dans votre code source.

| Fichier / Dossier | Contenu |
|---|---|
| `state.json` | État courant de l'orchestrateur (polling dashboard) |
| `last-routes.json` | Snapshot RouteMap du dernier scan — base de comparaison pour `e2e-update` |
| `.e2e-cache.json` | Empreintes SHA-256 par fichier — Zero-Token Bypass |
| `storage.sqlite` | Métriques FinOps, historique runs, triages (SQLite WAL) |
| `coverage.json` | Résultats de couverture routes/forms |
| `coverage.html` | Rapport de couverture visuel |
| `arch-report.json` | Données brutes analyse ArchPolice |
| `arch-report.md` | Rapport lisible avec plan de refactoring LLM |
| `latest.log` | Log complet du dernier run |
| `patches-pending/` | Patches Ghostwriter en attente d'application (`--apply`) |
| `evolutions-pending/` | Propositions Evolver en attente de revue humaine |
| `evolutions-applied/` | Archive des évolutions appliquées via `e2e-evolve-apply` |
| `*.triage.json` | Résultats de triage Coroner par trace ID |

> `.e2e-work/` doit être ajouté à `.gitignore` si vous ne souhaitez pas versionner les artefacts.

---

## Structure du projet

```mermaid
graph LR
    IDX["🖥️ index.ts\nCLI · MCP · e2e-evolve-apply"] --> ORC["⚙️ orchestrator.ts\nMachine d'état · routing · cache"]

    ORC --> AG["🤖 agents/\n14 agents spécialisés"]
    ORC --> IN["🔌 integrations/\nSlack · Jira · SSH · Trello · Stripe"]
    ORC --> SV["📊 server/\nAPI Express · SPA · WebSocket"]

    AG --> UT["🛠️ utils/\ncache SHA-256 · métriques · rapports"]
    SV --> UT
```

📁 Arborescence complète

```
test-end-to-end/
├── src/
│   ├── orchestrator.ts            # Cerveau central : machine d'état, routage, Zero-Token Bypass
│   ├── index.ts                   # CLI · MCP (11 outils) · e2e-evolve-apply
│   ├── agents/
│   │   ├── scout.ts               # Extraction AST routes/forms (ts-morph)
│   │   ├── artisan.ts             # Génération specs Playwright depuis RouteMap
│   │   ├── runner.ts              # Exécution des tests + capture du contexte de crash
│   │   ├── coroner.ts             # Triage : BACKEND_BUG / SELECTOR_DRIFT / NETWORK_ERROR
│   │   ├── ghostwriter.ts         # Génération de patches + création PR (dry-run par défaut)
│   │   ├── evolver.ts             # Auto-amélioration des agents — gate supervisé
│   │   ├── sentinel.ts            # Audit OWASP des PRs via gh CLI
│   │   ├── chaosMonkey.ts         # Injection de chaos réseau (6 scénarios)
│   │   ├── coverage.ts            # Carte de couverture routes/forms
│   │   ├── updater.ts             # Sync intelligente des tests après modifications
│   │   ├── archPolice.ts          # Analyse statique de l'architecture
│   │   ├── rgpdGuard.ts           # Masquage PII avant écriture disque
│   │   ├── qaEngineer.ts          # Génération de tests de régression post-patch
│   │   └── dependabot.ts          # npm audit + fix LLM + vérification + PR
│   ├── integrations/
│   │   ├── notifier.ts            # Webhooks Slack / Discord / Teams
│   │   ├── atlassian.ts           # Jira + Xray
│   │   ├── trello.ts              # Trello (TODO → DONE)
│   │   └── cloudDeployer.ts       # SSH OVH / IONOS / Hostinger + logs post-crash
│   ├── server/
│   │   ├── app.ts                 # API Express dashboard (8 routes)
│   │   ├── start.ts               # Point d'entrée serveur, WebSocket
│   │   └── public/
│   │       └── index.html         # SPA dashboard 8 onglets — zéro CDN
│   └── utils/
│       ├── cache.ts               # Cache SHA-256 + SQLite WAL
│       ├── compressor.ts          # Compression de prompts Byte-State
│       ├── logDigest.ts           # Parsing et digest de logs
│       ├── metricsTracker.ts      # Métriques FinOps / Green-IT
│       ├── stripeMock.ts          # Simulation webhooks Stripe (test)
│       └── report.ts              # Générateur de rapports CLI
├── commands/                      # Définitions des skills Claude Code (10 commandes)
├── docs/assets/                   # Captures d'écran + logo
├── scripts/setup.sh               # Setup complet en une commande
├── .env.example                   # Template de configuration (toutes les variables)
├── package.json
├── tsconfig.json
└── playwright.config.ts
```

---

## Contribuer

Les PRs sont les bienvenues — ouvrir une issue en premier pour les changements non triviaux.  
Lancer `npx tsc --noEmit` avant de soumettre — zéro erreur de type requise.  
Chaque nouvel agent doit respecter le contrat JSON typé défini dans `src/orchestrator.ts` (`AgentTask`, `RouteMap`, `BugReport`).

---

## Licence

MIT — Aron Beaufort
