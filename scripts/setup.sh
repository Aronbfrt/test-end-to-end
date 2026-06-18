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
npm run build --silent 2>&1 | grep -E "error|Error" | head -5 || true
ok "Build dist/ prêt"

# ── 4. Git ────────────────────────────────────────────────────────────────────
if command -v git &>/dev/null; then
  GIT_VER=$(git --version | awk '{print $3}')
  ok "Git ${GIT_VER}"
else
  warn "Git non trouvé — les commandes diff/predictive seront désactivées."
fi

# ── 5. Playwright browsers ────────────────────────────────────────────────────
log "Installation du navigateur Playwright (Chromium)..."
npx playwright install chromium --quiet 2>/dev/null && ok "Playwright Chromium installé" || warn "Playwright install échoué — relance manuellement : npx playwright install"

# ── 6. Ollama (optionnel — Zero-Token Bypass) ─────────────────────────────────
if command -v ollama &>/dev/null; then
  ok "Ollama détecté"
  if curl -s http://localhost:11434/api/tags 2>/dev/null | grep -q "llama3.2"; then
    ok "llama3.2 déjà disponible"
  else
    log "Téléchargement de llama3.2 (Zero-Token Bypass)..."
    ollama pull llama3.2 && ok "llama3.2 prêt" || warn "Pull Ollama échoué — mode regex fallback actif"
  fi
else
  warn "Ollama non installé — le moteur tourne en mode regex (moins précis)."
  warn "Installe Ollama : https://ollama.com/download"
fi

# ── 7. GitHub CLI (Sentinel) ──────────────────────────────────────────────────
if command -v gh &>/dev/null; then
  ok "GitHub CLI $(gh --version | head -1 | awk '{print $3}')"
else
  warn "GitHub CLI non trouvé — l'agent Sentinel sera désactivé."
  warn "Installe : https://cli.github.com"
fi

# ── 8. .env template ─────────────────────────────────────────────────────────
if [ ! -f .env ]; then
  cat > .env << 'ENVEOF'
# ── ChatOps (laisser vide pour désactiver) ────────────────────────────────────
SLACK_WEBHOOK_URL=
DISCORD_WEBHOOK_URL=
TEAMS_WEBHOOK_URL=

# ── Jira / Xray ───────────────────────────────────────────────────────────────
JIRA_URL=
JIRA_TOKEN=
JIRA_PROJECT_KEY=QA

# ── Trello ────────────────────────────────────────────────────────────────────
TRELLO_API_KEY=
TRELLO_TOKEN=
TRELLO_BOARD_ID=
TRELLO_TODO_LIST_ID=
TRELLO_DONE_LIST_ID=

# ── GitHub Sentinel ───────────────────────────────────────────────────────────
GITHUB_TOKEN=

# ── Cloud Deploy ──────────────────────────────────────────────────────────────
OVH_APP_KEY=
OVH_APP_SECRET=
OVH_CONSUMER_KEY=
OVH_SERVICE_NAME=
IONOS_API_KEY=
SSH_HOST=
SSH_USER=ubuntu
SSH_KEY_PATH=~/.ssh/id_rsa
SSH_LOG_PATH=/var/log/nginx/error.log

# ── Stripe (test env) ─────────────────────────────────────────────────────────
STRIPE_WEBHOOK_SECRET=
ENVEOF
  ok ".env créé — remplis tes clés pour activer les intégrations"
else
  ok ".env existant conservé"
fi

# ── 9. .e2e-work/ ────────────────────────────────────────────────────────────
mkdir -p .e2e-work
ok ".e2e-work/ initialisé"

# ── 10. .gitignore ────────────────────────────────────────────────────────────
if [ -f .gitignore ]; then
  grep -q ".env" .gitignore || echo ".env" >> .gitignore
  grep -q "src/database/storage.sqlite" .gitignore || echo "src/database/storage.sqlite" >> .gitignore
  ok ".gitignore à jour (.env + storage.sqlite exclus)"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${GREEN}  ✓ Setup terminé — moteur prêt.${NC}"
echo ""
echo "  Commandes rapides :"
echo "    node dist/index.js audit /ton/projet"
echo "    node dist/index.js audit /ton/projet --level=3"
echo "    node dist/server/start.js  →  http://127.0.0.1:4321"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
