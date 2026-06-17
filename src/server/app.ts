/**
 * app.ts — Real-time dashboard server (Express + WebSocket).
 *
 * Exposes:
 *   GET  /              → HTML dashboard (SPA, inline CSS+JS, no bundler)
 *   GET  /api/status    → current orchestrator state JSON
 *   GET  /api/report    → last generated report.html as JSON payload
 *   POST /api/repair    → trigger ghostwriter on a specific traceId
 *   WS   /ws            → bidirectional event stream
 *       server→client:  { type, payload } — LOG | STATE | SCREENSHOT | METRIC | HOTSPOT
 *       client→server:  { type, payload } — PING | REPAIR_REQUEST
 *
 * CI/CD:
 *   generateReport(runs, outputPath) → standalone report.html with embedded
 *   Confidence Index (0–100) + meta comment suitable for GitHub PR injection.
 */

import express, { Request, Response, NextFunction } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { diagnostics } from '../orchestrator.js';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface WsEvent {
  type: 'LOG' | 'STATE' | 'SCREENSHOT' | 'METRIC' | 'HOTSPOT' | 'REPORT_READY';
  payload: unknown;
  ts: number;
}

export interface TestRun {
  id: string;
  route: string;
  testName: string;
  verdict: 'PASS' | 'FAIL' | 'SKIP';
  durationMs: number;
  screenshotPath?: string;
  traceId?: string;
}

export interface RunSummary {
  runs: TestRun[];
  /** Token usage for this session (from Anthropic response metadata). */
  tokensUsed: number;
  tokensSaved: number;
  /** Files bypassed by cache — zero cost. */
  cachedFiles: number;
}

// ── WebSocket broadcast ────────────────────────────────────────────────────────

let _wss: WebSocketServer | null = null;

export function broadcast(event: WsEvent): void {
  if (!_wss) return;
  const raw = JSON.stringify(event);
  _wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(raw);
    }
  });
}

/** Convenience wrapper — agents call this to stream log lines live. */
export function streamLog(message: string): void {
  broadcast({ type: 'LOG', payload: message, ts: Date.now() });
  // Also write to stdout so CI sees it
  console.log(message);
}

export function streamState(state: string): void {
  broadcast({ type: 'STATE', payload: state, ts: Date.now() });
}

export function streamMetric(key: string, value: number | string): void {
  broadcast({ type: 'METRIC', payload: { key, value }, ts: Date.now() });
}

export function streamScreenshot(b64Png: string, label: string): void {
  broadcast({ type: 'SCREENSHOT', payload: { b64Png, label }, ts: Date.now() });
}

// ── CI/CD report generator ─────────────────────────────────────────────────────

/**
 * Compute the Applicative Confidence Index (0–100).
 *
 * Formula:
 *   baseScore = passRate × 60          (weight: test results)
 *   cacheBonus = min(cachedPct, 1) × 10 (reward for unchanged files)
 *   tokenBonus = min(savedPct, 1) × 10  (reward for token efficiency)
 *   securityPenalty = failedSecurity × 5
 *   result = clamp(baseScore + cacheBonus + tokenBonus − securityPenalty, 0, 100)
 */
function computeConfidenceIndex(summary: RunSummary): number {
  const total   = summary.runs.length;
  if (total === 0) return 0;

  const passed  = summary.runs.filter((r) => r.verdict === 'PASS').length;
  const passRate = passed / total;
  const securityFails = summary.runs.filter(
    (r) => r.verdict === 'FAIL' && r.testName.includes('attacker'),
  ).length;

  const savedPct  = summary.tokensUsed > 0
    ? summary.tokensSaved / (summary.tokensUsed + summary.tokensSaved)
    : 0;
  const cachedPct = summary.cachedFiles > 0 && total > 0
    ? Math.min(summary.cachedFiles / total, 1)
    : 0;

  const score =
    passRate * 60 +
    cachedPct * 10 +
    savedPct * 10 +
    Math.min(passed / Math.max(total, 1), 1) * 20 -
    securityFails * 5;

  return Math.round(Math.max(0, Math.min(100, score)));
}

function badgeColor(score: number): string {
  if (score >= 80) return '#22c55e'; // green
  if (score >= 60) return '#f59e0b'; // amber
  return '#ef4444';                  // red
}

function verdictEmoji(v: TestRun['verdict']): string {
  return v === 'PASS' ? '✅' : v === 'FAIL' ? '❌' : '⏭️';
}

/**
 * Generate a self-contained report.html with embedded styles, data, and the
 * Confidence Index.  No external assets — works offline and as a CI artefact.
 */
export function generateReport(summary: RunSummary, outputPath: string): string {
  const ci     = computeConfidenceIndex(summary);
  const color  = badgeColor(ci);
  const total  = summary.runs.length;
  const passed = summary.runs.filter((r) => r.verdict === 'PASS').length;
  const failed = summary.runs.filter((r) => r.verdict === 'FAIL').length;
  const skipped = summary.runs.filter((r) => r.verdict === 'SKIP').length;

  const routes = [...new Set(summary.runs.map((r) => r.route))];

  const routeRows = routes.map((route) => {
    const runs    = summary.runs.filter((r) => r.route === route);
    const hasFail = runs.some((r) => r.verdict === 'FAIL');
    const allPass = runs.every((r) => r.verdict === 'PASS');
    const status  = hasFail ? 'fail' : allPass ? 'pass' : 'warn';
    const label   = hasFail ? 'FAIL' : allPass ? 'PASS' : 'WARN';
    const failRun = runs.find((r) => r.verdict === 'FAIL');
    return `<div class="route-row ${status}">
      <div class="route-dot dot-${status}"></div>
      <div class="route-info">
        <span class="route-path">${escHtml(route)}</span>
        ${failRun?.traceId ? `<button class="btn-patch" data-trace="${escHtml(failRun.traceId)}">Auto-Patch</button>` : ''}
      </div>
      <span class="route-badge badge-${status}">${label}</span>
      <span class="route-count">${runs.length} test${runs.length !== 1 ? 's' : ''}</span>
    </div>`;
  }).join('');

  const tableRows = summary.runs.map((r) => `
    <tr class="${r.verdict.toLowerCase()}">
      <td><span class="verdict-pill pill-${r.verdict.toLowerCase()}">${r.verdict}</span></td>
      <td class="mono">${escHtml(r.route)}</td>
      <td>${escHtml(r.testName)}</td>
      <td class="dim">${r.durationMs}ms</td>
    </tr>`).join('');

  const ciRing = `conic-gradient(${color} ${ci * 3.6}deg, #1e293b ${ci * 3.6}deg)`;

  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>V-Infinite — IC ${ci}/100</title>
<!-- e2e-confidence-index: ${ci} -->
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0f172a;--surface:#1a2236;--border:#263147;
  --text:#e2e8f0;--muted:#64748b;--subtle:#94a3b8;
  --pass:#4ade80;--fail:#f87171;--warn:#fbbf24;
  --accent:#6366f1;--accent2:#06b6d4;
}
body{font-family:-apple-system,'Segoe UI',sans-serif;background:var(--bg);color:var(--text);
  min-height:100vh;display:flex;flex-direction:column}

/* ── Header ── */
.topbar{
  background:var(--surface);border-bottom:1px solid var(--border);
  padding:12px 24px;display:flex;align-items:center;gap:12px;flex-shrink:0
}
.topbar-brand{font-size:15px;font-weight:700;color:#fff;letter-spacing:-.3px}
.topbar-brand em{color:var(--accent);font-style:normal}
.pill{padding:3px 9px;border-radius:20px;font-size:10px;font-weight:600;letter-spacing:.4px}
.pill-mcp{background:#1e1b4b;color:#818cf8;border:1px solid #3730a3}
.pill-ollama{background:#052e16;color:#4ade80;border:1px solid #166534}
.pill-done{background:#042f2e;color:#2dd4bf;border:1px solid #0f766e}
.pill-running{background:#1c1917;color:#fbbf24;border:1px solid #92400e}
.topbar-right{margin-left:auto;font-size:11px;color:var(--muted)}

/* ── Main layout ── */
.layout{flex:1;display:grid;grid-template-columns:1fr 300px;overflow:hidden}
.main{overflow-y:auto;padding:20px 24px;display:flex;flex-direction:column;gap:16px}
.sidebar{background:var(--surface);border-left:1px solid var(--border);
  display:flex;flex-direction:column;overflow:hidden}

/* ── Hero bar ── */
.hero{
  background:var(--surface);border:1px solid var(--border);border-radius:12px;
  padding:20px 24px;display:flex;align-items:center;gap:28px
}
.ci-ring-wrap{position:relative;width:80px;height:80px;flex-shrink:0}
.ci-ring{
  width:80px;height:80px;border-radius:50%;
  background:${ciRing};
  display:flex;align-items:center;justify-content:center
}
.ci-inner{
  width:62px;height:62px;border-radius:50%;background:var(--bg);
  display:flex;flex-direction:column;align-items:center;justify-content:center
}
.ci-num{font-size:22px;font-weight:800;color:${color};line-height:1}
.ci-sub{font-size:8px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-top:1px}
.hero-stats{display:flex;gap:20px;flex:1;flex-wrap:wrap}
.hstat{display:flex;flex-direction:column;gap:2px}
.hstat-val{font-size:24px;font-weight:700;line-height:1}
.hstat-lbl{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px}
.c-pass{color:var(--pass)} .c-fail{color:var(--fail)} .c-warn{color:var(--warn)}
.c-blue{color:#60a5fa} .c-purple{color:#a78bfa}
.hero-right{margin-left:auto;display:flex;flex-direction:column;align-items:flex-end;gap:6px}
.progress-wrap{display:flex;align-items:center;gap:8px}
.progress-label{font-size:10px;color:var(--muted)}
.progress{height:5px;width:140px;background:var(--border);border-radius:3px;overflow:hidden}
.progress-fill{height:100%;background:linear-gradient(90deg,var(--accent),var(--accent2));border-radius:3px}

/* ── Section ── */
.section{background:var(--surface);border:1px solid var(--border);border-radius:12px;overflow:hidden}
.section-head{
  padding:12px 16px;border-bottom:1px solid var(--border);
  display:flex;align-items:center;justify-content:space-between
}
.section-title{font-size:11px;font-weight:600;color:var(--subtle);text-transform:uppercase;letter-spacing:.8px}
.section-meta{font-size:10px;color:var(--muted)}

/* ── Route list ── */
.route-row{
  display:grid;grid-template-columns:10px 1fr auto auto;gap:10px;align-items:center;
  padding:10px 16px;border-bottom:1px solid var(--border);
  transition:background .15s
}
.route-row:last-child{border-bottom:none}
.route-row:hover{background:#1f2e47}
.route-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.dot-pass{background:var(--pass);box-shadow:0 0 6px #4ade8055}
.dot-fail{background:var(--fail);box-shadow:0 0 6px #f8717155}
.dot-warn{background:var(--warn);box-shadow:0 0 6px #fbbf2455}
.route-info{display:flex;align-items:center;gap:10px;min-width:0}
.route-path{font-family:'SF Mono','Fira Code',monospace;font-size:12px;
  color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.route-badge{padding:2px 7px;border-radius:4px;font-size:9px;font-weight:700;letter-spacing:.5px}
.badge-pass{background:#052e16;color:var(--pass)}
.badge-fail{background:#2d0e0e;color:var(--fail)}
.badge-warn{background:#2d1f0e;color:var(--warn)}
.route-count{font-size:10px;color:var(--muted);white-space:nowrap}
.btn-patch{
  background:linear-gradient(135deg,#4f46e5,#7c3aed);color:#fff;border:none;
  padding:3px 8px;border-radius:4px;font-size:10px;font-weight:600;
  cursor:pointer;white-space:nowrap;flex-shrink:0
}
.btn-patch:hover{opacity:.85}
.btn-patch.loading{opacity:.5;cursor:not-allowed}

/* ── Test table ── */
details summary{
  padding:12px 16px;cursor:pointer;font-size:11px;font-weight:600;
  color:var(--subtle);text-transform:uppercase;letter-spacing:.8px;
  list-style:none;display:flex;align-items:center;justify-content:space-between
}
details summary::after{content:'▸';color:var(--muted)}
details[open] summary::after{content:'▾'}
table{width:100%;border-collapse:collapse}
th{padding:8px 16px;text-align:left;font-size:10px;color:var(--muted);
  text-transform:uppercase;letter-spacing:.5px;background:var(--bg);
  border-bottom:1px solid var(--border)}
td{padding:9px 16px;border-bottom:1px solid var(--border);font-size:12px}
tr:last-child td{border-bottom:none}
tr:hover td{background:#1f2e47}
.verdict-pill{padding:2px 7px;border-radius:4px;font-size:9px;font-weight:700;letter-spacing:.5px}
.pill-pass{background:#052e16;color:var(--pass)}
.pill-fail{background:#2d0e0e;color:var(--fail)}
.pill-skip{background:#1e293b;color:var(--muted)}
.mono{font-family:'SF Mono','Fira Code',monospace;font-size:11px}
.dim{color:var(--muted)}

/* ── Sidebar log ── */
.log-head{
  padding:12px 16px;border-bottom:1px solid var(--border);
  display:flex;align-items:center;justify-content:space-between;flex-shrink:0
}
.log-title{font-size:11px;font-weight:600;color:var(--subtle);
  text-transform:uppercase;letter-spacing:.8px}
.ws-indicator{display:flex;align-items:center;gap:5px;font-size:10px;color:var(--muted)}
.ws-dot{width:6px;height:6px;border-radius:50%;background:var(--pass);
  box-shadow:0 0 4px var(--pass)}
.ws-dot.off{background:var(--muted);box-shadow:none}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.3}}
.ws-dot.live{animation:blink 2s infinite}
.log-body{
  flex:1;overflow-y:auto;padding:6px 0;
  font-family:'SF Mono','Fira Code',monospace;font-size:10.5px;
  scrollbar-width:thin;scrollbar-color:var(--border) transparent
}
.log-entry{padding:2px 14px;line-height:1.6;display:flex;gap:8px;align-items:baseline}
.log-ts{color:#3d5068;flex-shrink:0;font-size:9.5px}
.log-agent{font-weight:700;flex-shrink:0;font-size:10px}
.ag-orch{color:#60a5fa} .ag-scout{color:#818cf8} .ag-artisan{color:#a78bfa}
.ag-coroner{color:#f472b6} .ag-ghost{color:#34d399} .ag-evolver{color:#fbbf24}
.log-msg{color:var(--subtle)}

/* ── Footer ── */
footer{
  background:var(--surface);border-top:1px solid var(--border);
  padding:10px 24px;font-size:10px;color:var(--muted);
  display:flex;justify-content:space-between;align-items:center;flex-shrink:0
}
</style>
</head>
<body>

<div class="topbar">
  <span class="topbar-brand">test-end-to-end <em>V-Infinite</em></span>
  <span class="pill pill-mcp">MCP</span>
  <span class="pill pill-ollama" id="ollama-pill">⬤ Ollama</span>
  <span class="pill pill-done" id="state-pill">DONE</span>
  <span class="topbar-right" id="run-meta">Généré le ${new Date().toLocaleString('fr-FR')}</span>
</div>

<div class="layout">
  <div class="main">

    <!-- Hero: IC + métriques clés -->
    <div class="hero">
      <div class="ci-ring-wrap">
        <div class="ci-ring">
          <div class="ci-inner">
            <span class="ci-num">${ci}</span>
            <span class="ci-sub">IC</span>
          </div>
        </div>
      </div>
      <div class="hero-stats">
        <div class="hstat"><span class="hstat-val c-pass">${passed}</span><span class="hstat-lbl">Passés</span></div>
        <div class="hstat"><span class="hstat-val c-fail">${failed}</span><span class="hstat-lbl">Échoués</span></div>
        <div class="hstat"><span class="hstat-val c-warn">${skipped}</span><span class="hstat-lbl">Ignorés</span></div>
        <div class="hstat"><span class="hstat-val c-blue" id="cache-val">${summary.cachedFiles}</span><span class="hstat-lbl">Cache hits</span></div>
        <div class="hstat"><span class="hstat-val c-purple" id="token-val">${summary.tokensSaved.toLocaleString()}</span><span class="hstat-lbl">Tokens écon.</span></div>
      </div>
      <div class="hero-right">
        <div class="progress-wrap">
          <span class="progress-label">Couverture</span>
          <div class="progress"><div class="progress-fill" style="width:${Math.round((passed/Math.max(total,1))*100)}%"></div></div>
          <span class="progress-label">${Math.round((passed/Math.max(total,1))*100)}%</span>
        </div>
      </div>
    </div>

    <!-- Route Impact Map -->
    <div class="section">
      <div class="section-head">
        <span class="section-title">Route Impact Map</span>
        <span class="section-meta">${routes.length} routes · ${total} tests</span>
      </div>
      ${routeRows}
    </div>

    <!-- Tests détaillés (repliés par défaut) -->
    <div class="section">
      <details>
        <summary>Tous les tests <span style="color:var(--muted);font-weight:400">(${total})</span></summary>
        <table>
          <thead><tr><th>Résultat</th><th>Route</th><th>Test</th><th>Durée</th></tr></thead>
          <tbody>${tableRows}</tbody>
        </table>
      </details>
    </div>

  </div>

  <!-- Sidebar: log temps réel -->
  <div class="sidebar">
    <div class="log-head">
      <span class="log-title">Log en direct</span>
      <div class="ws-indicator">
        <div class="ws-dot off" id="ws-dot"></div>
        <span id="ws-status">—</span>
      </div>
    </div>
    <div class="log-body" id="ws-log"></div>
  </div>
</div>

<footer>
  <span>test-end-to-end V-Infinite 2.0.0</span>
  <span>IC ${ci}/100 · ${passed}/${total} passés</span>
</footer>

<script>
(function(){
  const log    = document.getElementById('ws-log');
  const dot    = document.getElementById('ws-dot');
  const status = document.getElementById('ws-status');
  const pill   = document.getElementById('state-pill');
  const proto  = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const agentColors = {
    orch:'ag-orch',scout:'ag-scout',artisan:'ag-artisan',
    coroner:'ag-coroner',ghost:'ag-ghost',ghostwriter:'ag-ghost',evolver:'ag-evolver'
  };

  function addLine(ts, agent, msg) {
    const row  = document.createElement('div'); row.className = 'log-entry';
    const time = document.createElement('span'); time.className = 'log-ts';
    time.textContent = new Date(ts).toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
    const ag = document.createElement('span');
    const key = Object.keys(agentColors).find(k => agent && agent.includes(k));
    ag.className = 'log-agent ' + (key ? agentColors[key] : 'ag-orch');
    ag.textContent = agent ? '[' + agent + ']' : '[—]';
    const m  = document.createElement('span'); m.className = 'log-msg'; m.textContent = msg;
    row.append(time, ag, m);
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
  }

  function parseLogLine(raw) {
    const m = raw.match(/\\[(\\w+)\\s[\\d:]+\\]\\s(\\[([\\w-]+)\\]\\s)?(.+)/);
    if (m) return { agent: m[3] || 'orch', msg: m[4] };
    return { agent: 'orch', msg: raw };
  }

  let ws;
  function connect() {
    try {
      ws = new WebSocket(proto + '//' + location.host + '/ws');
      ws.onopen = () => {
        dot.className = 'ws-dot live';
        status.textContent = 'Connecté';
      };
      ws.onclose = () => {
        dot.className = 'ws-dot off';
        status.textContent = 'Déconnecté';
      };
      ws.onmessage = (e) => {
        const ev = JSON.parse(e.data);
        if (ev.type === 'LOG') {
          const p = parseLogLine(String(ev.payload));
          addLine(ev.ts, p.agent, p.msg);
        }
        if (ev.type === 'STATE') {
          pill.textContent = ev.payload;
          pill.className = 'pill ' + (ev.payload === 'DONE' ? 'pill-done' : 'pill-running');
        }
        if (ev.type === 'METRIC') {
          const { key, value } = ev.payload;
          if (key === 'cachedFiles') document.getElementById('cache-val').textContent = value;
          if (key === 'tokensSaved') document.getElementById('token-val').textContent = value;
        }
        if (ev.type === 'REPORT_READY') location.reload();
      };
    } catch(_) {
      dot.className = 'ws-dot off';
      status.textContent = 'Mode statique';
    }
  }
  connect();

  document.querySelectorAll('.btn-patch').forEach(function(btn) {
    btn.addEventListener('click', function() {
      if (btn.classList.contains('loading')) return;
      btn.classList.add('loading');
      btn.textContent = 'En cours…';
      fetch('/api/repair', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ traceId: btn.dataset.trace })
      }).then(() => {
        btn.textContent = 'Queued ✓';
        addLine(Date.now(), 'ghost', 'Réparation déclenchée — ' + btn.dataset.trace);
      }).catch(() => { btn.textContent = 'Erreur'; btn.classList.remove('loading'); });
    });
  });
})();
</script>
</body>
</html>`;

  writeFileSync(outputPath, html, 'utf-8');
  console.log(`[server] report written → ${outputPath} (CI: ${ci}%)`);
  broadcast({ type: 'REPORT_READY', payload: { path: outputPath, ci }, ts: Date.now() });
  return html;
}

function escHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Format a PR comment with the Confidence Index for GitHub Actions injection. */
export function buildPrComment(summary: RunSummary, reportUrl?: string): string {
  const ci     = computeConfidenceIndex(summary);
  const color  = badgeColor(ci).replace('#', '');
  const total  = summary.runs.length;
  const passed = summary.runs.filter((r) => r.verdict === 'PASS').length;
  const failed = summary.runs.filter((r) => r.verdict === 'FAIL').length;

  const failList = summary.runs
    .filter((r) => r.verdict === 'FAIL')
    .slice(0, 10)
    .map((r) => `  - \`${r.route}\` — ${r.testName}`)
    .join('\n');

  return [
    `## 🤖 E2E Autonomous Audit`,
    ``,
    `![Confidence Index](https://img.shields.io/badge/Confidence%20Index-${ci}%25-${color}?style=for-the-badge)`,
    ``,
    `| Tests | Passed | Failed | Tokens used | Tokens saved |`,
    `|-------|--------|--------|-------------|--------------|`,
    `| ${total} | ${passed} | ${failed} | ${summary.tokensUsed} | ${summary.tokensSaved} |`,
    ``,
    failed > 0 ? `### Failing tests\n${failList}\n` : `All tests passing ✅\n`,
    reportUrl ? `[View full report](${reportUrl})` : '',
    ``,
    `<!-- e2e-confidence-index: ${ci} -->`,
  ].filter((l) => l !== undefined).join('\n');
}

// ── Express + WebSocket server ─────────────────────────────────────────────────

export function createApp(targetPath: string) {
  const app    = express();
  const server = createServer(app);
  _wss = new WebSocketServer({ server, path: '/ws' });

  app.use(express.json());

  // ── WebSocket handler ──────────────────────────────────────────────────────
  _wss.on('connection', (ws) => {
    ws.send(JSON.stringify({
      type: 'STATE',
      payload: diagnostics().state,
      ts: Date.now(),
    }));

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as { type: string; payload?: unknown };
        if (msg.type === 'PING') {
          ws.send(JSON.stringify({ type: 'LOG', payload: 'pong', ts: Date.now() }));
        }
      } catch { /* ignore malformed */ }
    });
  });

  // ── REST routes ────────────────────────────────────────────────────────────

  app.get('/', (_req: Request, res: Response) => {
    const reportPath = join(targetPath, 'tests', 'report.html');
    if (existsSync(reportPath)) {
      res.sendFile(reportPath);
    } else {
      res.status(200).send(`<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>V-Infinite — Prêt</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,'Segoe UI',sans-serif;background:#0f172a;color:#e2e8f0;
  min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:0;
  padding:40px 20px}
.card{background:#1a2236;border:1px solid #263147;border-radius:16px;padding:48px;
  max-width:520px;width:100%;text-align:center}
.icon{font-size:48px;margin-bottom:20px}
h1{font-size:22px;font-weight:700;color:#fff;margin-bottom:8px}
p{font-size:14px;color:#64748b;line-height:1.6;margin-bottom:28px}
.steps{text-align:left;display:flex;flex-direction:column;gap:12px;margin-bottom:28px}
.step{display:flex;gap:12px;align-items:flex-start}
.step-num{background:linear-gradient(135deg,#6366f1,#06b6d4);color:#fff;
  width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;
  font-size:11px;font-weight:700;flex-shrink:0;margin-top:1px}
.step-text{font-size:13px;color:#94a3b8;line-height:1.5}
code{background:#0f172a;border:1px solid #263147;padding:2px 6px;border-radius:4px;
  font-family:'SF Mono','Fira Code',monospace;font-size:12px;color:#818cf8}
.status{display:flex;align-items:center;gap:8px;justify-content:center;
  font-size:12px;color:#64748b;margin-top:20px}
.dot{width:6px;height:6px;border-radius:50%;background:#4ade80;
  box-shadow:0 0 4px #4ade80;animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
</style>
</head>
<body>
<div class="card">
  <div class="icon">🤖</div>
  <h1>test-end-to-end V-Infinite</h1>
  <p>Aucun rapport généré pour l'instant.<br>Lance un audit pour voir le dashboard s'activer.</p>
  <div class="steps">
    <div class="step">
      <div class="step-num">1</div>
      <div class="step-text">Audit rapide (niveau 1, sans IA) :<br>
        <code>node dist/index.js audit --level=1</code></div>
    </div>
    <div class="step">
      <div class="step-num">2</div>
      <div class="step-text">Audit complet avec Vision IA :<br>
        <code>node dist/index.js audit --level=2 --predictive</code></div>
    </div>
    <div class="step">
      <div class="step-num">3</div>
      <div class="step-text">Shadow Personas + auto-patch :<br>
        <code>node dist/index.js shadow --level=3 --chaos</code></div>
    </div>
  </div>
  <div class="status"><div class="dot"></div>Serveur actif — en attente d'un audit</div>
</div>
<script>
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  try {
    const ws = new WebSocket(proto + '//' + location.host + '/ws');
    ws.onmessage = function(e) {
      const ev = JSON.parse(e.data);
      if (ev.type === 'REPORT_READY') location.reload();
    };
  } catch(_) {}
</script>
</body>
</html>`);
    }
  });

  app.get('/api/status', (_req: Request, res: Response) => {
    res.json(diagnostics());
  });

  app.get('/api/report', (_req: Request, res: Response) => {
    const reportPath = join(targetPath, 'tests', 'report.html');
    if (!existsSync(reportPath)) {
      res.status(404).json({ error: 'No report generated yet.' });
      return;
    }
    res.json({ html: readFileSync(reportPath, 'utf-8') });
  });

  app.post('/api/repair', async (req: Request, res: Response) => {
    const { traceId } = req.body as { traceId?: string };
    if (!traceId) {
      res.status(400).json({ error: 'traceId required' });
      return;
    }

    streamLog(`[dashboard] repair requested for traceId: ${traceId}`);

    // Load triage result written by coroner
    const triagePath = join(targetPath, '.e2e-work', `${traceId}.triage.json`);
    if (!existsSync(triagePath)) {
      res.status(404).json({ error: 'Triage result not found. Run an audit first.' });
      return;
    }

    const triage = JSON.parse(readFileSync(triagePath, 'utf-8')) as {
      verdict: string;
      bugReport?: import('../orchestrator.js').BugReport;
    };

    if (triage.verdict !== 'BACKEND_BUG' || !triage.bugReport) {
      res.status(422).json({ error: `Verdict is ${triage.verdict} — only BACKEND_BUG triggers ghostwriter.` });
      return;
    }

    // Fire-and-forget ghostwriter
    res.json({ status: 'queued', traceId });

    setImmediate(async () => {
      try {
        const { run } = await import('../agents/ghostwriter.js') as {
          run: (t: import('../orchestrator.js').AgentTask, c: import('../orchestrator.js').RunConfig, o: null) => Promise<unknown>
        };
        const result = await run(
          { type: 'WRITE_PATCH', bugReport: triage.bugReport! },
          { command: 'repair', level: 2, chaos: false, predictive: false, targetPath },
          null,
        ) as { success: boolean; branch: string; prUrl?: string };

        streamLog(`[ghostwriter] ${result.success ? '✓ patch applied' : '✗ patch failed'} — branch: ${result.branch}`);
        if (result.prUrl) streamLog(`[ghostwriter] PR: ${result.prUrl}`);
        broadcast({ type: 'REPORT_READY', payload: result, ts: Date.now() });
      } catch (err) {
        streamLog(`[ghostwriter] error: ${(err as Error).message}`);
      }
    });
  });

  // Global error handler
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[server] unhandled error:', err.message);
    res.status(500).json({ error: err.message });
  });

  return { app, server };
}

// ── Start ──────────────────────────────────────────────────────────────────────

export function startServer(
  targetPath: string,
  port = parseInt(process.env.E2E_PORT ?? '4321', 10),
): void {
  const { server } = createApp(targetPath);
  server.listen(port, '127.0.0.1', () => {
    console.log(`[server] dashboard → http://127.0.0.1:${port}`);
    console.log(`[server] WebSocket → ws://127.0.0.1:${port}/ws`);
  });
}
