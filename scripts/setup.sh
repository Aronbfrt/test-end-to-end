#!/usr/bin/env bash
# setup.sh — Magic Install pour test-end-to-end
# Usage: bash scripts/setup.sh  ou  npm run setup

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log()  { echo -e "${BLUE}[setup]${NC} $1"; }
ok()   { echo -e "${GREEN}[setup]${NC} ✓ $1"; }
warn() { echo -e "${YELLOW}[setup]${NC} ⚠ $1"; }
fail() { echo -e "${RED}[setup]${NC} ✗ $1"; exit 1; }

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  test-end-to-end — Magic Install V-Infinite 2.0"
echo "  13 agents · 11 MCP tools · Zero-Token Bypass"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ── 1. Node.js version ────────────────────────────────────────────────────────
NODE_VER=$(node --version 2>/dev/null | sed 's/v//' | cut -d. -f1) || fail "Node.js introuvable. Installe Node 18+."
if [ "$NODE_VER" -lt 18 ]; then
  fail "Node.js ${NODE_VER} détecté — version 18+ requise."
fi
ok "Node.js v$(node --version | sed 's/v//')"

# ── 2. npm install ────────────────────────────────────────────────────────────
log "Installation des dépendances npm..."
npm install --silent 2>&1 | tail -2
ok "Dépendances installées"

# ── 3. Build TypeScript ───────────────────────────────────────────────────────
log "Compilation TypeScript..."
npm run build 2>&1 | grep -E "^src.*error|Error" | head -5 || true
if [ -f dist/index.js ]; then
  ok "Build dist/ prêt"
else
  fail "Build échoué — dist/index.js introuvable. Lance : npm run build"
fi

# ── 4. Vérification du moteur ────────────────────────────────────────────────
node dist/index.js --version 2>/dev/null && ok "Moteur opérationnel" || warn "Vérification moteur échouée — relance : node dist/index.js --help"

# ── 5. Git ────────────────────────────────────────────────────────────────────
if command -v git &>/dev/null; then
  GIT_VER=$(git --version | awk '{print $3}')
  ok "Git ${GIT_VER}"
else
  warn "Git non trouvé — commandes diff/predictive désactivées."
fi

# ── 6. Playwright browsers ────────────────────────────────────────────────────
log "Installation du navigateur Playwright (Chromium)..."
npx playwright install chromium --quiet 2>/dev/null && ok "Playwright Chromium installé" || warn "Playwright install échoué — relance : npx playwright install chromium"

# ── 7. Ollama (optionnel — Zero-Token Bypass) ─────────────────────────────────
if command -v ollama &>/dev/null; then
  ok "Ollama détecté"
  if curl -s http://localhost:11434/api/tags 2>/dev/null | grep -q "llama3.2"; then
    ok "llama3.2 déjà disponible — Zero-Token Bypass actif"
  else
    log "Téléchargement de llama3.2 (recommandé pour 8Go RAM)..."
    ollama pull llama3.2 && ok "llama3.2 prêt — Zero-Token Bypass actif" || warn "Pull Ollama échoué — mode regex fallback actif"
  fi
else
  warn "Ollama non installé — le moteur tourne en mode Claude API (tokens consommés pour chaque analyse)."
  warn "Pour activer le Zero-Token Bypass : https://ollama.com/download"
fi

# ── 8. GitHub CLI (Ghostwriter + Sentinel) ───────────────────────────────────
if command -v gh &>/dev/null; then
  ok "GitHub CLI $(gh --version | head -1 | awk '{print $3}') — Ghostwriter et Sentinel actifs"
else
  warn "GitHub CLI non trouvé — création de PR automatique et audit Sentinel désactivés."
  warn "Installe : https://cli.github.com"
fi

# ── 9. .env template ─────────────────────────────────────────────────────────
if [ ! -f .env ]; then
  cat > .env << 'ENVEOF'
# test-end-to-end — Configuration
# Toutes les intégrations sont OPT-IN : laisser vide = module désactivé.

# ── LLM local (Zero-Token Bypass) ─────────────────────────────────────────────
OLLAMA_HOST=http://127.0.0.1:11434

# ── Dashboard ─────────────────────────────────────────────────────────────────
E2E_PORT=4321

# ── GitHub (Ghostwriter + Sentinel) ───────────────────────────────────────────
GITHUB_TOKEN=

# ── ChatOps — Slack ───────────────────────────────────────────────────────────
SLACK_WEBHOOK_URL=

# ── ChatOps — Discord ─────────────────────────────────────────────────────────
DISCORD_WEBHOOK_URL=

# ── ChatOps — Microsoft Teams ─────────────────────────────────────────────────
TEAMS_WEBHOOK_URL=

# ── Atlassian — Jira + Xray ───────────────────────────────────────────────────
JIRA_URL=
JIRA_TOKEN=
JIRA_USER_EMAIL=
JIRA_PROJECT_KEY=QA

# ── Trello ────────────────────────────────────────────────────────────────────
TRELLO_API_KEY=
TRELLO_TOKEN=
TRELLO_TODO_LIST_ID=
TRELLO_DONE_LIST_ID=

# ── Stripe (simulation webhooks — test env uniquement) ────────────────────────
STRIPE_WEBHOOK_SECRET=

# ── OVHcloud ──────────────────────────────────────────────────────────────────
OVH_APP_KEY=
OVH_APP_SECRET=
OVH_CONSUMER_KEY=
OVH_PROJECT_ID=
OVH_SERVICE_NAME=

# ── IONOS (déploiement via GitHub Actions) ────────────────────────────────────
IONOS_GITHUB_REPO=
IONOS_GITHUB_TOKEN=
IONOS_WORKFLOW_FILE=deploy.yml
IONOS_DEPLOY_BRANCH=main

# ── Hostinger (webhook de déploiement) ───────────────────────────────────────
HOSTINGER_DEPLOY_WEBHOOK_URL=

# ── Logs SSH post-crash ───────────────────────────────────────────────────────
SSH_HOST=
SSH_PORT=22
SSH_USER=ubuntu
SSH_PRIVATE_KEY=~/.ssh/id_rsa

# ── Sécurité dépendances (Dependabot) ────────────────────────────────────────
DEPENDABOT_MIN_SEVERITY=high
ENVEOF
  ok ".env créé — remplis les variables pour activer les intégrations"
else
  ok ".env existant conservé"
fi

# ── 10. .e2e-work/ ───────────────────────────────────────────────────────────
mkdir -p .e2e-work
ok ".e2e-work/ initialisé"

# ── 11. .gitignore ───────────────────────────────────────────────────────────
if [ -f .gitignore ]; then
  grep -q "^\.env$" .gitignore || echo ".env" >> .gitignore
  grep -q "storage\.sqlite" .gitignore || echo ".e2e-work/storage.sqlite" >> .gitignore
  ok ".gitignore à jour (.env + storage.sqlite exclus)"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${GREEN}  ✓ Setup terminé — 13 agents prêts.${NC}"
echo ""
echo "  Commandes rapides :"
echo "    node dist/index.js audit /ton/projet          → audit complet"
echo "    node dist/index.js audit /ton/projet --level=3 → audit + auto-patch PR"
echo "    node dist/index.js sentinel --pr=42            → audit sécurité PR"
echo "    node dist/index.js arch /ton/projet            → analyse architecture"
echo "    node dist/index.js chaos /ton/projet           → specs chaos réseau"
echo "    node dist/server/start.js  →  http://127.0.0.1:4321"
echo ""
echo "  MCP (.mcp.json) :"
echo "    { \"mcpServers\": { \"e2e\": { \"command\": \"node\","
echo "      \"args\": [\"$(pwd)/dist/index.js\", \"--mcp\"] } } }"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
