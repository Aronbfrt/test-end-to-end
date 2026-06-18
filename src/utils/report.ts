/**
 * report.ts — Shared types + CLI report writer.
 * Used by orchestrator (CLI) and imported by app.ts (dashboard).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// ── Shared types ────────────────────────────────────────────────────────────────

export interface TestRun {
  id: string;
  route: string;
  testName: string;
  verdict: 'PASS' | 'FAIL' | 'SKIP';
  durationMs: number;
  screenshotPath?: string;
  traceId?: string;
}

export interface HotspotEntry {
  file: string;
  risk: number;
  churn: number;
  stress: number;
}

export interface RunSummary {
  runs: TestRun[];
  tokensUsed: number;
  tokensSaved: number;
  cachedFiles: number;
  hotspots?: HotspotEntry[];
}

// ── CI computation ─────────────────────────────────────────────────────────────

export function computeConfidenceIndex(summary: RunSummary): number {
  const total = summary.runs.length;
  if (total === 0) return 0;

  const passed       = summary.runs.filter((r) => r.verdict === 'PASS').length;
  const passRate     = passed / total;
  const securityFails = summary.runs.filter(
    (r) => r.verdict === 'FAIL' && r.testName.includes('attacker'),
  ).length;
  const savedPct   = summary.tokensUsed > 0
    ? summary.tokensSaved / (summary.tokensUsed + summary.tokensSaved) : 0;
  const cachedPct  = summary.cachedFiles > 0 && total > 0
    ? Math.min(summary.cachedFiles / total, 1) : 0;
  const passedRoutes = new Set(summary.runs.filter((r) => r.verdict === 'PASS').map((r) => r.route)).size;
  const totalRoutes  = new Set(summary.runs.map((r) => r.route)).size;
  const routeCoverage = totalRoutes > 0 ? passedRoutes / totalRoutes : 0;

  return Math.round(Math.max(0, Math.min(100,
    passRate * 60 + cachedPct * 10 + savedPct * 10 + routeCoverage * 20 - securityFails * 5,
  )));
}

// ── CLI report writer ──────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function pill(verdict: TestRun['verdict']): string {
  const cls = verdict === 'PASS' ? 'pass' : verdict === 'FAIL' ? 'fail' : 'skip';
  return `<span class="pill ${cls}">${verdict}</span>`;
}

export function writeCliReport(summary: RunSummary, outputPath: string): number {
  const ci       = computeConfidenceIndex(summary);
  const total    = summary.runs.length;
  const passed   = summary.runs.filter((r) => r.verdict === 'PASS').length;
  const failed   = summary.runs.filter((r) => r.verdict === 'FAIL').length;
  const skipped  = summary.runs.filter((r) => r.verdict === 'SKIP').length;
  const routes   = [...new Set(summary.runs.map((r) => r.route))];
  const covPct   = Math.round((passed / Math.max(total, 1)) * 100);
  const ciColor  = ci >= 80 ? '#4ade80' : ci >= 60 ? '#fbbf24' : '#f87171';
  const genDate  = new Date().toLocaleString('fr-FR');

  const routeRows = routes.map((route) => {
    const runs     = summary.runs.filter((r) => r.route === route);
    const hasFail  = runs.some((r) => r.verdict === 'FAIL');
    const allPass  = runs.every((r) => r.verdict === 'PASS');
    const label    = hasFail ? 'FAIL' : allPass ? 'PASS' : 'WARN';
    const cls      = hasFail ? 'fail' : allPass ? 'pass' : 'warn';
    const avgMs    = Math.round(runs.reduce((a, r) => a + r.durationMs, 0) / runs.length);
    const inner    = runs.map((r) => `<tr><td>${pill(r.verdict)}</td><td>${esc(r.testName)}</td><td class="dim">${r.durationMs}ms</td>${r.traceId ? `<td class="mono dim" style="font-size:10px">${esc(r.traceId)}</td>` : '<td></td>'}</tr>`).join('');
    return `<tr class="route-row"><td><span class="rbadge ${cls}">${label}</span></td><td class="mono">${esc(route)}</td><td class="dim">${runs.length} tests · ${avgMs}ms avg</td></tr>${inner}`;
  }).join('');

  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>V-Infinite — IC ${ci}/100</title>
<!-- e2e-confidence-index: ${ci} -->
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,'Segoe UI',sans-serif;background:#0f172a;color:#e2e8f0;padding:24px}
.hero{background:#1a2236;border:1px solid #263147;border-radius:12px;padding:24px;display:flex;align-items:center;gap:24px;margin-bottom:20px}
.ci-ring{width:80px;height:80px;border-radius:50%;background:conic-gradient(${ciColor} ${ci * 3.6}deg,#1e293b ${ci * 3.6}deg);display:flex;align-items:center;justify-content:center;flex-shrink:0}
.ci-inner{width:62px;height:62px;border-radius:50%;background:#0f172a;display:flex;flex-direction:column;align-items:center;justify-content:center}
.ci-num{font-size:22px;font-weight:800;color:${ciColor};line-height:1}
.ci-sub{font-size:8px;color:#64748b;text-transform:uppercase;letter-spacing:.6px;margin-top:2px}
.stats{display:flex;gap:24px;flex-wrap:wrap}
.stat{display:flex;flex-direction:column;gap:3px}
.stat-val{font-size:22px;font-weight:700;line-height:1}
.stat-lbl{font-size:9px;color:#64748b;text-transform:uppercase;letter-spacing:.5px}
.c-pass{color:#4ade80}.c-fail{color:#f87171}.c-warn{color:#fbbf24}.c-blue{color:#60a5fa}
.card{background:#1a2236;border:1px solid #263147;border-radius:10px;overflow:hidden;margin-bottom:16px}
.card-hd{padding:11px 16px;border-bottom:1px solid #263147;font-size:10px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:.8px;display:flex;justify-content:space-between}
table{width:100%;border-collapse:collapse}
th{padding:7px 14px;text-align:left;font-size:9px;color:#64748b;text-transform:uppercase;letter-spacing:.5px;background:#0f172a;border-bottom:1px solid #263147}
td{padding:8px 14px;border-bottom:1px solid #1e293b;font-size:12px}
tr:last-child td{border-bottom:none}
tr:hover td{background:#1a2a40}
.route-row td{background:#141f33;font-weight:600}
.pill{padding:2px 6px;border-radius:3px;font-size:9px;font-weight:700;letter-spacing:.5px}
.pill.pass{background:#0a2d14;color:#4ade80}
.pill.fail{background:#2d0e0e;color:#f87171}
.pill.skip{background:#1e293b;color:#64748b}
.rbadge{padding:2px 6px;border-radius:3px;font-size:9px;font-weight:700;letter-spacing:.5px}
.rbadge.pass{background:#0a2d14;color:#4ade80}
.rbadge.fail{background:#2d0e0e;color:#f87171}
.rbadge.warn{background:#2d1f00;color:#fbbf24}
.mono{font-family:'SF Mono','Fira Code',monospace;font-size:11px}
.dim{color:#64748b}
footer{text-align:center;padding:16px;font-size:10px;color:#64748b;margin-top:8px}
</style>
</head>
<body>
<div class="hero">
  <div class="ci-ring"><div class="ci-inner"><span class="ci-num">${ci}</span><span class="ci-sub">IC / 100</span></div></div>
  <div class="stats">
    <div class="stat"><span class="stat-val c-pass">${passed}</span><span class="stat-lbl">Passés</span></div>
    <div class="stat"><span class="stat-val c-fail">${failed}</span><span class="stat-lbl">Échoués</span></div>
    <div class="stat"><span class="stat-val c-warn">${skipped}</span><span class="stat-lbl">Ignorés</span></div>
    <div class="stat"><span class="stat-val c-blue">${routes.length}</span><span class="stat-lbl">Routes</span></div>
    <div class="stat"><span class="stat-val dim">${summary.cachedFiles}</span><span class="stat-lbl">Cache hits</span></div>
  </div>
  <div style="margin-left:auto;text-align:right">
    <div style="font-size:20px;font-weight:700;color:${ciColor}">${covPct}%</div>
    <div style="font-size:10px;color:#64748b">Couverture</div>
    <div style="font-size:10px;color:#64748b;margin-top:8px">${genDate}</div>
  </div>
</div>

<div class="card">
  <div class="card-hd"><span>Tests par route</span><span>${total} tests · ${routes.length} routes</span></div>
  <table>
    <thead><tr><th>Verdict</th><th>Route</th><th>Tests</th><th>Nom du test</th><th>Trace ID</th></tr></thead>
    <tbody>${routeRows}</tbody>
  </table>
</div>

<footer>test-end-to-end V-Infinite 2.0.0 · IC ${ci}/100 · ${passed}/${total} passés</footer>
</body>
</html>`;

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, html, 'utf-8');
  return ci;
}
