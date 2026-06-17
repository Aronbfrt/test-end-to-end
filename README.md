<p align="center"><img src="docs/assets/report-screenshot.png" alt="test-end-to-end" width="720"></p>

<h1 align="center">test-end-to-end — V-Infinite</h1>

<p align="center"><b>Autonomous QA ecosystem &amp; MCP server for Claude Code.</b></p>

<p align="center">
Zero human prompt required. Analyses your codebase, generates E2E tests,<br>
triages crashes, heals broken selectors via AI vision, opens PRs with surgical fixes.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-5.4-3178c6?style=flat-square&logo=typescript&logoColor=white">
  <img src="https://img.shields.io/badge/MCP-native-5046e4?style=flat-square">
  <img src="https://img.shields.io/badge/Ollama-Zero--Token%20Bypass-green?style=flat-square">
  <img src="https://img.shields.io/badge/Claude-claude--sonnet--4--6%20Vision-orange?style=flat-square">
</p>

---

## Architecture

```
src/
├── index.ts           CLI (--level, --chaos, --predictive) + MCP server (6 tools)
├── orchestrator.ts    State machine · Ollama Zero-Token Bypass · agent dispatch
├── utils/
│   ├── cache.ts       SHA-256 fingerprint registry — crash-safe atomic writes
│   ├── compressor.ts  Byte-State 3-pass DOM compressor (95% token reduction)
│   └── logDigest.ts   Crash log → triptyque (assertion + DOM + console)
├── agents/
│   ├── scout.ts       AST mapping · doc alignment · Git forensics hotspots
│   ├── artisan.ts     POM test generator · Shadow Personas · Chaos injection
│   ├── coroner.ts     Triage (5xx vs selector drift) · Vision QA · SHIELD pixel-diff
│   ├── ghostwriter.ts Bug patch · e2e-patch/* branch · autonomous PR
│   └── evolver.ts     Meta-programming self-improvement · evolution-log.jsonl
└── server/
    └── app.ts         Express dashboard · WebSocket stream · CI/CD report.html

commands/              Claude Code slash commands (Python/Selenium legacy stack)
templates/
├── e2e/               Python · Selenium · Playwright · Cypress · Robot Framework
├── playwright/        playwright.config.ts blueprint
└── cypress/           cypress.config.ts blueprint
```

---

## Slash commands (Python/Selenium legacy stack)

| Command | Description |
|---|---|
| `/e2e-init` | Guided setup — framework choice, env vars, bootstrap |
| `/e2e-audit` | Full audit: basic + SEO + security + a11y + perf + responsive |
| `/e2e-coverage` | Route/form/API coverage map with % and gaps |
| `/e2e-update` | Smart sync after code changes — protects manual tests |

---

## CLI / MCP (TypeScript V-Infinite stack)

```bash
npm install && npm run build

node dist/index.js <command> [flags]
```

### Commands

| Command | What it does |
|---|---|
| `init` | Stack detection · cache seed · POM scaffold |
| `audit` | Full audit + triage + ghostwriter (level 2+) |
| `shadow` | Zero-Prompt Reverse Testing + all 3 Shadow Personas |
| `diff` | Scope to `git diff` only · optional `--predictive` hotspot overlay |
| `repair` | Load coroner triage → ghostwriter → PR |

### Flags

| Flag | Effect |
|---|---|
| `--level=1` | Local AST only — no LLM |
| `--level=2` | Hybrid: Vision QA on selector failure *(default)* |
| `--level=3` | Meta-Agent Infinite: Personas + Ghostwriter + Evolver |
| `--chaos` | Network faults + double-click + i18n permutations |
| `--predictive` | 12-month Git forensics → Psychological Code Hotspots |
| `--reset-cache` | Wipe `.e2e-cache.json`, force full rescan |
| `--mcp` | Start as MCP stdio server for nested agent orchestration |

### MCP tools (Claude agents / nested orchestration)

```
e2e_init · e2e_audit · e2e_shadow · e2e_diff · e2e_repair · e2e_diagnostics
```

```jsonc
// .mcp.json
{
  "mcpServers": {
    "e2e": {
      "command": "node",
      "args": ["dist/index.js", "--mcp"],
      "cwd": "/absolute/path/to/test-end-to-end"
    }
  }
}
```

---

## Zero-Token Bypass

Ollama detected on host → AST/string tasks route locally (0 Anthropic tokens).  
File hash unchanged since last run → agent never invoked.

```
Run 1 (cold):  73 files → 73 stale  (0  bypassed)
Run 2 (warm):  73 files → 0  stale  (73 bypassed)  ← 100% cache hit
```

---

## Shadow Personas (`--chaos` / `--level=3`)

| Persona | Behaviour |
|---|---|
| `frustrated_user` | Rage-click ×3, form abandonment, back-nav mid-flow |
| `impulsive_buyer` | Skips required fields, forces checkout |
| `malicious_attacker` | XSS (6 payloads) · SQLi (5) · path traversal · prompt injection if AI route detected |
| `chaos_network` | Offline mid-form · 200ms/req throttle · double-submit idempotency check |

---

## SHIELD — Pixel-Diff Anti-False-Alert

Failure screenshot vs baseline: pure-JS PNG decoder → per-pixel Euclidean distance in RGBA.

| Parameter | Value | Purpose |
|---|---|---|
| Tolerance | 32 / 255 per channel | Absorbs ClearType, font hinting, OS anti-aliasing |
| Threshold | 1% of pixels | Minimum difference before alert fires |
| Below threshold | `SHIELD ABSORBED` | No alert — cosmetic noise |
| Above threshold | Vision QA activated | Claude claude-sonnet-4-6 multimodal identifies new selector |

---

## Confidence Index

Embedded in `report.html` and PR comments:

```
CI = passRate    × 60
   + cacheBonus  × 10   (unchanged files / total)
   + tokenBonus  × 10   (tokens saved / total)
   + coverage    × 20   (passed / total)
   − secFails    × 5    (failed attacker-persona tests)
   → clamped 0–100
```

---

## Git Forensics Hotspots (`--predictive`)

12 months of `git log` analysed. Commit stress scored:

| Pattern | Score |
|---|---|
| `fix`, `hotfix`, `urgent`, `critical` | +3 |
| `wip`, `temp`, `hack`, `dirty` | +2 |
| Expletives (`crap`, `wtf`, `ugh` …) | +3 |
| `revert`, `rollback`, `broke` | +2 |
| Late-night commit (23h–04h) | +2 |

`riskScore = churn × 1.0 + stress × 1.5` — top 20 files get denser coverage.

---

## Autonomous repair pipeline

```
Test failure
    │
    ▼
Coroner triage
    ├─ HTTP 5xx       → BACKEND_BUG
    │                     Ghostwriter: localise handler → Claude Patch[]
    │                     git checkout -b e2e-patch/<ts>-<route>
    │                     apply · verify · gh pr create
    │
    └─ HTTP 200
        ├─ selector found  → ASSERTION_BUG (fix test logic)
        └─ selector missing
            ├─ SHIELD: no visual diff → SELECTOR_DRIFT
            │          Vision QA → resilient CSS selector → POM updated
            └─ visual diff > 5%      → LAYOUT_CHANGE → escalate
```

---

## Self-evolution (Evolver)

On repeated failure (guard: max 3× per agent per 24h):

1. Reads failing agent TypeScript source
2. Claude analyses root cause → `improvements[]` (exact `oldCode` match required)
3. Applies surgical patch to `/src`
4. Commits `refactor(evolver): self-patch <agent>`
5. Appends to `.e2e-work/evolution-log.jsonl`

After 3 failures in 24h → escalates to human, stops self-patching.

---

## Installation

### Python/Selenium stack (legacy commands)

```bash
cp -r templates/e2e/ tests/
pip install pytest selenium pytest-html requests
# Robot Framework only:
pip install robotframework robotframework-seleniumlibrary robotframework-requests
# Playwright Python:
pip install playwright && playwright install chromium
# Playwright TS / Cypress:
npm install --save-dev @playwright/test   # or cypress

cp tests/.env.test.example tests/.env.test
# Edit TEST_BASE_URL, TEST_USERNAME, TEST_PASSWORD, TEST_LOGIN_PATH …
```

### TypeScript V-Infinite stack

```bash
npm install
npm run build

# CLI
node dist/index.js audit --level=2 --predictive

# Dashboard (http://127.0.0.1:4321)
node --input-type=module <<'EOF'
import { startServer } from './dist/server/app.js';
startServer(process.cwd());
EOF
```

---

## Environment variables

```env
TEST_BASE_URL=http://localhost:3000
TEST_USERNAME=test@example.com
TEST_PASSWORD=testpassword
TEST_LOGIN_PATH=/login              # Adjust for /connexion, /signin …
TEST_ADMIN_DASHBOARD_PATH=/admin
TEST_AUTH_URL_HINTS=login,signin,auth
E2E_PORT=4321
OLLAMA_HOST=http://127.0.0.1:11434
```

---

## Supported frameworks

| Framework | Init | Audit | Coverage | Update | V-Infinite |
|---|---|---|---|---|---|
| Selenium + pytest | ✅ | ✅ | ✅ | ✅ | — |
| Playwright Python | ✅ | ✅ | ✅ | ✅ | — |
| Playwright TypeScript | ✅ | ✅ | ✅ | ✅ | ✅ |
| Cypress | ✅ | ✅ | ✅ | ✅ | ✅ |
| Robot Framework | ✅ | ✅ | ✅ | ✅ | — |
| MCP native (TS) | ✅ | ✅ | — | — | ✅ |

---

**Author:** Aron Beaufort · [GitHub](https://github.com/Aronbfrt/test-end-to-end)
