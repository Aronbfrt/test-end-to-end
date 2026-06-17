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
  const ci    = computeConfidenceIndex(summary);
  const color = badgeColor(ci);
  const total  = summary.runs.length;
  const passed = summary.runs.filter((r) => r.verdict === 'PASS').length;
  const failed = summary.runs.filter((r) => r.verdict === 'FAIL').length;

  const tableRows = summary.runs.map((r) => `
    <tr class="${r.verdict.toLowerCase()}">
      <td>${verdictEmoji(r.verdict)}</td>
      <td>${escHtml(r.testName)}</td>
      <td>${escHtml(r.route)}</td>
      <td>${r.durationMs}ms</td>
      <td>${r.traceId
        ? `<a href="#" data-trace="${escHtml(r.traceId ?? '')}">replay</a>`
        : '—'}</td>
    </tr>`).join('');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>E2E Report — Confidence ${ci}%</title>
<!-- e2e-confidence-index: ${ci} -->
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,-apple-system,sans-serif;background:#0f172a;color:#e2e8f0;padding:2rem}
  h1{font-size:1.75rem;margin-bottom:1.5rem;color:#f8fafc}
  .header{display:flex;align-items:center;gap:2rem;margin-bottom:2rem}
  .ci-badge{
    display:flex;flex-direction:column;align-items:center;
    background:${color};border-radius:12px;padding:.75rem 1.5rem;
    min-width:120px;
  }
  .ci-number{font-size:2.5rem;font-weight:700;color:#fff;line-height:1}
  .ci-label{font-size:.7rem;color:rgba(255,255,255,.8);text-transform:uppercase;letter-spacing:.1em;margin-top:.25rem}
  .stats{display:flex;gap:1.5rem;flex-wrap:wrap}
  .stat{background:#1e293b;border-radius:8px;padding:1rem 1.5rem;text-align:center}
  .stat-n{font-size:1.75rem;font-weight:700}
  .stat-l{font-size:.75rem;color:#94a3b8;margin-top:.25rem}
  .pass .stat-n{color:#22c55e} .fail .stat-n{color:#ef4444}
  .token .stat-n{color:#818cf8}
  table{width:100%;border-collapse:collapse;margin-top:2rem;background:#1e293b;border-radius:10px;overflow:hidden}
  th{background:#0f172a;padding:.75rem 1rem;text-align:left;font-size:.75rem;color:#94a3b8;text-transform:uppercase;letter-spacing:.1em}
  td{padding:.75rem 1rem;border-bottom:1px solid #334155;font-size:.875rem}
  tr.pass td:first-child{color:#22c55e}
  tr.fail td:first-child{color:#ef4444}
  tr.skip td:first-child{color:#94a3b8}
  a{color:#818cf8;text-decoration:none}
  a:hover{text-decoration:underline}
  .route-tree{margin-top:2rem;background:#1e293b;border-radius:10px;padding:1.5rem}
  .tree-title{font-size:1rem;font-weight:600;margin-bottom:1rem;color:#f8fafc}
  .tree-node{display:flex;align-items:center;gap:.5rem;padding:.35rem 0;border-left:2px solid #334155;padding-left:1rem;margin-left:.5rem}
  .tree-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
  .dot-pass{background:#22c55e} .dot-fail{background:#ef4444} .dot-skip{background:#475569}
  footer{margin-top:3rem;font-size:.75rem;color:#475569;text-align:center}
  #ws-log{margin-top:2rem;background:#0f172a;border:1px solid #334155;border-radius:8px;padding:1rem;height:200px;overflow-y:auto;font-family:monospace;font-size:.8rem;color:#94a3b8}
</style>
</head>
<body>

<div class="header">
  <div>
    <h1>E2E Audit Report</h1>
    <p style="color:#94a3b8;font-size:.875rem">Generated ${new Date().toISOString()}</p>
  </div>
  <div class="ci-badge">
    <span class="ci-number">${ci}</span>
    <span class="ci-label">Confidence Index</span>
  </div>
</div>

<div class="stats">
  <div class="stat pass"><div class="stat-n">${passed}</div><div class="stat-l">Passed</div></div>
  <div class="stat fail"><div class="stat-n">${failed}</div><div class="stat-l">Failed</div></div>
  <div class="stat"><div class="stat-n">${total}</div><div class="stat-l">Total</div></div>
  <div class="stat token"><div class="stat-n">${summary.tokensUsed.toLocaleString()}</div><div class="stat-l">Tokens used</div></div>
  <div class="stat token"><div class="stat-n">${summary.tokensSaved.toLocaleString()}</div><div class="stat-l">Tokens saved (cache)</div></div>
  <div class="stat"><div class="stat-n">${summary.cachedFiles}</div><div class="stat-l">Files bypassed</div></div>
</div>

<!-- Route Impact Tree -->
<div class="route-tree">
  <div class="tree-title">Route Impact Map</div>
  ${[...new Set(summary.runs.map((r) => r.route))].map((route) => {
    const routeRuns = summary.runs.filter((r) => r.route === route);
    const hasFail   = routeRuns.some((r) => r.verdict === 'FAIL');
    const allPass   = routeRuns.every((r) => r.verdict === 'PASS');
    const cls = hasFail ? 'fail' : allPass ? 'pass' : 'skip';
    return `<div class="tree-node">
      <div class="tree-dot dot-${cls}"></div>
      <span>${escHtml(route)}</span>
      <span style="color:#475569;font-size:.75rem;margin-left:auto">${routeRuns.length} test${routeRuns.length !== 1 ? 's' : ''}</span>
    </div>`;
  }).join('')}
</div>

<table>
  <thead><tr>
    <th>Result</th><th>Test</th><th>Route</th><th>Duration</th><th>Replay</th>
  </tr></thead>
  <tbody>${tableRows}</tbody>
</table>

<!-- Live log (shown when server is running) -->
<div id="ws-log">Connecting to live stream…</div>

<footer>
  test-end-to-end v0.1.0 · Applicative Confidence Index: ${ci}/100 ·
  ${passed}/${total} tests passed
</footer>

<script>
(function(){
  const log = document.getElementById('ws-log');
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  let ws;
  function connect() {
    try {
      ws = new WebSocket(proto + '//' + location.host + '/ws');
      ws.onopen = () => { log.textContent = ''; };
      ws.onmessage = (e) => {
        const ev = JSON.parse(e.data);
        if (ev.type === 'LOG') {
          const line = document.createElement('div');
          line.textContent = new Date(ev.ts).toLocaleTimeString() + ' ' + ev.payload;
          log.appendChild(line);
          log.scrollTop = log.scrollHeight;
        }
        if (ev.type === 'STATE') {
          document.title = 'E2E — ' + ev.payload;
        }
        if (ev.type === 'REPORT_READY') {
          location.reload();
        }
      };
      ws.onerror = () => { log.textContent = 'WebSocket not available — static report mode.'; };
    } catch(e) {
      log.textContent = 'Static report mode.';
    }
  }
  connect();

  // Repair button
  document.querySelectorAll('a[data-trace]').forEach(function(a) {
    a.addEventListener('click', function(e) {
      e.preventDefault();
      fetch('/api/repair', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ traceId: a.getAttribute('data-trace') })
      }).then(() => alert('Repair job queued — watch the live log.'));
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
      res.status(200).send(`<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>test-end-to-end dashboard</title>
<style>body{font-family:system-ui;background:#0f172a;color:#e2e8f0;display:flex;
align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:1rem}
h1{font-size:1.5rem}p{color:#94a3b8}</style></head>
<body><h1>🤖 test-end-to-end</h1>
<p>No report yet. Run <code>npm run e2e:audit</code> to generate one.</p></body></html>`);
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
