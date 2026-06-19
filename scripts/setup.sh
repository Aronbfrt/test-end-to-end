#!/usr/bin/env bash
# setup.sh — Installation & vérification complète de test-end-to-end
# Usage : bash scripts/setup.sh   ou   npm run setup

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

log()  { echo -e "${BLUE}[setup]${NC} $1"; }
ok()   { echo -e "${GREEN}[setup]${NC} ✓ $1"; }
warn() { echo -e "${YELLOW}[setup]${NC} ⚠ $1"; }
fail() { echo -e "${RED}[setup]${NC} ✗ $1"; exit 1; }
info() { echo -e "${CYAN}[setup]${NC} → $1"; }
step() { echo -e "\n${BOLD}$1${NC}"; }

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  test-end-to-end — Setup V-Infinite 2.0"
echo "  13 agents · 11 MCP tools · Zero-Token Bypass"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ─────────────────────────────────────────────────────────────────────────────
# ÉTAPE 1 — Détection RAM et choix du modèle Ollama
# ─────────────────────────────────────────────────────────────────────────────
step "[ 1/7 ] Détection de la RAM disponible"

RAM_GB=0
if [[ "$(uname)" == "Darwin" ]]; then
  RAM_GB=$(( $(sysctl -n hw.memsize 2>/dev/null || echo 0) / 1024 / 1024 / 1024 ))
elif [[ -f /proc/meminfo ]]; then
  RAM_KB=$(grep MemTotal /proc/meminfo | awk '{print $2}')
  RAM_GB=$(( RAM_KB / 1024 / 1024 ))
fi

if [ "$RAM_GB" -ge 8 ]; then
  OLLAMA_MODEL="llama3.2"
  ok "RAM détectée : ${RAM_GB} Go → modèle sélectionné : llama3.2 (recommandé, qualité optimale)"
elif [ "$RAM_GB" -ge 4 ]; then
  OLLAMA_MODEL="llama3.1:8b"
  warn "RAM détectée : ${RAM_GB} Go → modèle sélectionné : llama3.1:8b (mode économie RAM)"
else
  OLLAMA_MODEL=""
  warn "RAM détectée : ${RAM_GB} Go — insuffisante pour Ollama. Zero-Token Bypass désactivé, inférence via Anthropic SDK uniquement."
fi

# ─────────────────────────────────────────────────────────────────────────────
# ÉTAPE 2 — Vérification et mises à jour des dépendances système
# ─────────────────────────────────────────────────────────────────────────────
step "[ 2/7 ] Vérification des dépendances système"

# Node.js
if command -v node &>/dev/null; then
  NODE_CURRENT=$(node --version | sed 's/v//')
  NODE_MAJOR=$(echo "$NODE_CURRENT" | cut -d. -f1)
  if [ "$NODE_MAJOR" -lt 18 ]; then
    fail "Node.js ${NODE_CURRENT} détecté — version 18+ requise. Mets à jour : https://nodejs.org"
  fi
  # Vérifier si une version majeure plus récente existe via npm registry
  NODE_LATEST_MAJOR=$(curl -s https://nodejs.org/dist/index.json 2>/dev/null | grep -o '"version":"v[0-9]*' | head -1 | grep -o '[0-9]*$' || echo "$NODE_MAJOR")
  if [ "$NODE_LATEST_MAJOR" -gt "$NODE_MAJOR" ] 2>/dev/null; then
    warn "Node.js ${NODE_CURRENT} installé — version ${NODE_LATEST_MAJOR}.x disponible. Mise à jour recommandée : https://nodejs.org"
  else
    ok "Node.js ${NODE_CURRENT} — à jour"
  fi
else
  fail "Node.js introuvable. Installe Node 18+ : https://nodejs.org"
fi

# npm
if command -v npm &>/dev/null; then
  NPM_CURRENT=$(npm --version)
  NPM_LATEST=$(npm view npm version 2>/dev/null || echo "$NPM_CURRENT")
  if [ "$NPM_CURRENT" != "$NPM_LATEST" ]; then
    warn "npm ${NPM_CURRENT} installé — ${NPM_LATEST} disponible. Mise à jour : npm install -g npm"
  else
    ok "npm ${NPM_CURRENT} — à jour"
  fi
else
  fail "npm introuvable."
fi

# Git
if command -v git &>/dev/null; then
  ok "Git $(git --version | awk '{print $3}')"
else
  warn "Git non trouvé — commandes diff/predictive désactivées"
fi

# GitHub CLI
if command -v gh &>/dev/null; then
  GH_CURRENT=$(gh --version 2>/dev/null | head -1 | awk '{print $3}')
  GH_LATEST=$(curl -s https://api.github.com/repos/cli/cli/releases/latest 2>/dev/null | grep '"tag_name"' | sed 's/.*"v\([^"]*\)".*/\1/' || echo "$GH_CURRENT")
  if [ "$GH_CURRENT" != "$GH_LATEST" ] && [ -n "$GH_LATEST" ]; then
    warn "GitHub CLI ${GH_CURRENT} installé — ${GH_LATEST} disponible. Mise à jour : gh upgrade"
  else
    ok "GitHub CLI ${GH_CURRENT} — à jour"
  fi
else
  warn "GitHub CLI non trouvé — Ghostwriter + Sentinel désactivés. Installe : https://cli.github.com"
fi

# Ollama
if command -v ollama &>/dev/null; then
  OLLAMA_CURRENT=$(ollama --version 2>/dev/null | awk '{print $NF}' || echo "?")
  ok "Ollama ${OLLAMA_CURRENT}"
elif [ -n "$OLLAMA_MODEL" ]; then
  warn "Ollama non installé. Installe depuis https://ollama.com/download pour activer le Zero-Token Bypass."
  OLLAMA_MODEL=""
fi

# ─────────────────────────────────────────────────────────────────────────────
# ÉTAPE 3 — Installation des dépendances npm + build
# ─────────────────────────────────────────────────────────────────────────────
step "[ 3/7 ] Installation des dépendances npm"

log "npm install..."
npm install --silent 2>&1 | tail -2 || fail "npm install échoué"
ok "Dépendances installées"

log "Compilation TypeScript..."
if npm run build 2>&1 | grep -E "error TS" | head -5; then
  fail "Erreurs TypeScript détectées. Lance : npx tsc --noEmit pour le détail."
fi
if [ -f dist/index.js ]; then
  ok "Build dist/ prêt"
else
  fail "dist/index.js introuvable après build."
fi

# Rendre la commande `e2e` disponible globalement
chmod +x dist/index.js
npm link --silent 2>/dev/null && ok "Commande globale 'e2e' installée — ex: e2e audit /votre/projet" \
  || warn "npm link échoué — utilise : node dist/index.js <commande> (droits admin requis pour npm link)"

# ─────────────────────────────────────────────────────────────────────────────
# ÉTAPE 4 — Playwright
# ─────────────────────────────────────────────────────────────────────────────
step "[ 4/7 ] Installation Playwright"

PW_VERSION=$(npx playwright --version 2>/dev/null | awk '{print $2}' || echo "?")
log "Playwright ${PW_VERSION} — installation des navigateurs (Chromium)..."
npx playwright install chromium --quiet 2>/dev/null && ok "Playwright Chromium prêt" \
  || warn "Playwright install échoué — relance : npx playwright install chromium"

# ─────────────────────────────────────────────────────────────────────────────
# ÉTAPE 5 — Ollama + modèle adapté à la RAM
# ─────────────────────────────────────────────────────────────────────────────
step "[ 5/7 ] Configuration Ollama (Zero-Token Bypass)"

if [ -n "$OLLAMA_MODEL" ] && command -v ollama &>/dev/null; then
  OLLAMA_HOST_URL="${OLLAMA_HOST:-http://127.0.0.1:11434}"
  if curl -s "${OLLAMA_HOST_URL}/api/tags" 2>/dev/null | grep -q "\"${OLLAMA_MODEL}\""; then
    ok "${OLLAMA_MODEL} déjà disponible — Zero-Token Bypass actif"
  else
    log "Téléchargement de ${OLLAMA_MODEL} (RAM : ${RAM_GB} Go)..."
    ollama pull "${OLLAMA_MODEL}" && ok "${OLLAMA_MODEL} prêt — Zero-Token Bypass actif" \
      || warn "Pull ${OLLAMA_MODEL} échoué — mode API Anthropic uniquement"
  fi
else
  warn "Ollama ignoré — inférence via Anthropic SDK (tokens consommés)"
fi

# ─────────────────────────────────────────────────────────────────────────────
# ÉTAPE 6 — Enregistrement du plugin dans Claude Code (.claude/settings.json)
# ─────────────────────────────────────────────────────────────────────────────
step "[ 6/8 ] Enregistrement dans Claude Code"

PLUGIN_ABS="$(pwd)"
CLAUDE_SETTINGS="${HOME}/.claude/settings.json"

mkdir -p "${HOME}/.claude"

if [ ! -f "$CLAUDE_SETTINGS" ]; then
  echo '{"plugins":[]}' > "$CLAUDE_SETTINGS"
  ok "settings.json créé : ${CLAUDE_SETTINGS}"
fi

# Ajouter le plugin si absent (manipulation JSON via node)
node -e "
const fs = require('fs');
const path = '${CLAUDE_SETTINGS}';
const pluginPath = '${PLUGIN_ABS}';
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(path, 'utf8')); } catch(e) { cfg = {}; }
if (!Array.isArray(cfg.plugins)) cfg.plugins = [];
if (!cfg.plugins.includes(pluginPath)) {
  cfg.plugins.push(pluginPath);
  fs.writeFileSync(path, JSON.stringify(cfg, null, 2));
  console.log('ajouté');
} else {
  console.log('déjà présent');
}
" 2>/dev/null | grep -q "ajouté" \
  && ok "Plugin enregistré dans ${CLAUDE_SETTINGS}" \
  || ok "Plugin déjà présent dans ${CLAUDE_SETTINGS}"

# ─────────────────────────────────────────────────────────────────────────────
# ÉTAPE 7 — Configuration .env + .e2e-work/ + .gitignore
# ─────────────────────────────────────────────────────────────────────────────
step "[ 7/8 ] Configuration de l'environnement"

if [ ! -f .env ]; then
  cp .env.example .env 2>/dev/null || cat > .env << 'ENVEOF'
OLLAMA_HOST=http://127.0.0.1:11434
E2E_PORT=4321
GITHUB_TOKEN=
SLACK_WEBHOOK_URL=
DISCORD_WEBHOOK_URL=
TEAMS_WEBHOOK_URL=
JIRA_URL=
JIRA_TOKEN=
JIRA_USER_EMAIL=
JIRA_PROJECT_KEY=QA
TRELLO_API_KEY=
TRELLO_TOKEN=
TRELLO_TODO_LIST_ID=
TRELLO_DONE_LIST_ID=
STRIPE_WEBHOOK_SECRET=
OVH_APP_KEY=
OVH_APP_SECRET=
OVH_CONSUMER_KEY=
OVH_PROJECT_ID=
OVH_SERVICE_NAME=
IONOS_GITHUB_REPO=
IONOS_GITHUB_TOKEN=
IONOS_WORKFLOW_FILE=deploy.yml
IONOS_DEPLOY_BRANCH=main
HOSTINGER_DEPLOY_WEBHOOK_URL=
SSH_HOST=
SSH_PORT=22
SSH_USER=ubuntu
SSH_PRIVATE_KEY=~/.ssh/id_rsa
DEPENDABOT_MIN_SEVERITY=high
ENVEOF
  ok ".env créé depuis .env.example — remplis les variables pour activer les intégrations"
else
  ok ".env existant conservé"
fi

mkdir -p .e2e-work
ok ".e2e-work/ initialisé"

if [ -f .gitignore ]; then
  grep -q "^\.env$" .gitignore        || echo ".env"                    >> .gitignore
  grep -q "storage\.sqlite" .gitignore || echo ".e2e-work/storage.sqlite" >> .gitignore
  ok ".gitignore mis à jour"
fi

# ─────────────────────────────────────────────────────────────────────────────
# ÉTAPE 8 — Vérification finale : tout est-il bien installé ?
# ─────────────────────────────────────────────────────────────────────────────
step "[ 8/8 ] Vérification finale"

ERRORS=0

check_cmd() {
  local label="$1"; local cmd="$2"; local version_flag="${3:---version}"
  if command -v "$cmd" &>/dev/null; then
    ok "${label} : $($cmd $version_flag 2>/dev/null | head -1)"
  else
    warn "${label} : NON TROUVÉ"
    ERRORS=$((ERRORS + 1))
  fi
}

check_file() {
  local label="$1"; local path="$2"
  if [ -f "$path" ]; then
    ok "${label} : $path"
  else
    warn "${label} : MANQUANT — $path"
    ERRORS=$((ERRORS + 1))
  fi
}

check_cmd "Node.js"    node    "--version"
check_cmd "npm"        npm     "--version"
check_cmd "Git"        git     "--version"
check_file "dist/index.js"  "dist/index.js"
check_file "dist/server/start.js" "dist/server/start.js"

if command -v npx &>/dev/null; then
  PW_OK=$(npx playwright --version 2>/dev/null && echo "ok" || echo "")
  [ -n "$PW_OK" ] && ok "Playwright : $(npx playwright --version 2>/dev/null)" || warn "Playwright : NON INSTALLÉ"
fi

if command -v gh &>/dev/null; then
  ok "GitHub CLI : $(gh --version 2>/dev/null | head -1)"
else
  warn "GitHub CLI : NON TROUVÉ (Sentinel + Ghostwriter PR désactivés)"
fi

if command -v ollama &>/dev/null; then
  ok "Ollama : $(ollama --version 2>/dev/null | awk '{print $NF}')"
  if [ -n "$OLLAMA_MODEL" ]; then
    curl -s "${OLLAMA_HOST:-http://127.0.0.1:11434}/api/tags" 2>/dev/null | grep -q "\"${OLLAMA_MODEL}\"" \
      && ok "Modèle ${OLLAMA_MODEL} : disponible — Zero-Token Bypass ACTIF" \
      || warn "Modèle ${OLLAMA_MODEL} : non trouvé — relance : ollama pull ${OLLAMA_MODEL}"
  fi
else
  warn "Ollama : NON TROUVÉ — Zero-Token Bypass désactivé"
fi

# Vérification moteur plugin
node dist/index.js --help &>/dev/null && ok "Moteur plugin : opérationnel" \
  || { warn "Moteur plugin : erreur au démarrage — relance : node dist/index.js --help"; ERRORS=$((ERRORS + 1)); }

# ─────────────────────────────────────────────────────────────────────────────
# Résumé
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ "$ERRORS" -eq 0 ]; then
  echo -e "${GREEN}${BOLD}  ✓ Setup terminé — 13 agents prêts.${NC}"
else
  echo -e "${YELLOW}${BOLD}  ⚠ Setup terminé avec ${ERRORS} avertissement(s) — voir ci-dessus.${NC}"
fi
echo ""
echo "  Commandes rapides :"
echo "    node dist/index.js init /votre/projet             → init + génération tests"
echo "    node dist/index.js audit /votre/projet            → audit complet"
echo "    node dist/index.js audit /votre/projet --level=3  → audit + auto-patch PR"
echo "    node dist/index.js sentinel /votre/projet         → audit OWASP PRs"
echo "    node dist/index.js arch /votre/projet             → analyse architecture"
echo "    npm run dashboard                                  → http://localhost:4321"
echo ""
echo "  Intégration MCP (.mcp.json) :"
echo "    { \"mcpServers\": { \"e2e\": { \"command\": \"node\","
echo "      \"args\": [\"$(pwd)/dist/index.js\", \"--mcp\"] } } }"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
