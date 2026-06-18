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
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { diagnostics } from '../orchestrator.js';
import type { TestRun, RunSummary, HotspotEntry } from '../utils/report.js';
import { computeConfidenceIndex } from '../utils/report.js';

// ── Types ──────────────────────────────────────────────────────────────────────

export type { TestRun, RunSummary, HotspotEntry };

export interface WsEvent {
  type: 'LOG' | 'STATE' | 'SCREENSHOT' | 'METRIC' | 'HOTSPOT' | 'REPORT_READY';
  payload: unknown;
  ts: number;
}

// ── WebSocket broadcast ────────────────────────────────────────────────────────

let _wss: WebSocketServer | null = null;
let _logPath: string | null = null;

function persistLine(msg: string): void {
  if (!_logPath) return;
  try {
    appendFileSync(_logPath, `${new Date().toISOString()} ${msg}\n`, 'utf-8');
  } catch { /* non-fatal */ }
}

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
  persistLine(message);
  // Also write to stdout so CI sees it
  process.stdout.write(message + '\n');
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
  const ci      = computeConfidenceIndex(summary);
  const color   = badgeColor(ci);
  const total   = summary.runs.length;
  const passed  = summary.runs.filter((r) => r.verdict === 'PASS').length;
  const failed  = summary.runs.filter((r) => r.verdict === 'FAIL').length;
  const skipped = summary.runs.filter((r) => r.verdict === 'SKIP').length;
  const routes  = [...new Set(summary.runs.map((r) => r.route))];
  const coveragePct = Math.round((passed / Math.max(total, 1)) * 100);
  const ciRing  = `conic-gradient(${color} ${ci * 3.6}deg, #1e293b ${ci * 3.6}deg)`;
  const genDate = new Date().toLocaleString('fr-FR');

  // ── Persona definitions ─────────────────────────────────────────────────────
  const PERSONAS = [
    { key: 'frustrated', label: 'Frustrated User', emoji: '😤', color: '#818cf8',
      desc: 'Rage-clicks, abandon de panier, formulaires répétés.',
      keywords: ['frustrated', 'rage', 'abandon'] },
    { key: 'attacker',   label: 'Malicious Attacker', emoji: '💀', color: '#f472b6',
      desc: 'XSS, SQLi, path traversal, CSRF, injection.',
      keywords: ['attacker', 'xss', 'sqli', 'injection', 'traversal', 'malicious'] },
    { key: 'chaos',      label: 'Chaos Network', emoji: '🌐', color: '#fbbf24',
      desc: 'Déconnexion mid-paiement, double-submit, offline.',
      keywords: ['chaos', 'offline', 'throttle', 'double'] },
    { key: 'impulsive',  label: 'Impulsive Buyer', emoji: '🛒', color: '#34d399',
      desc: 'Achat rapide, mobile, session courte.',
      keywords: ['impulsive', 'buyer', 'quick', 'mobile'] },
  ];

  // ── Build persona data ──────────────────────────────────────────────────────
  const personaData = PERSONAS.map((p) => {
    const pr = summary.runs.filter((r) => p.keywords.some((k) => r.testName.toLowerCase().includes(k)));
    const pp = pr.filter((r) => r.verdict === 'PASS').length;
    const pf = pr.filter((r) => r.verdict === 'FAIL').length;
    const pRate = pr.length > 0 ? Math.round((pp / pr.length) * 100) : 0;
    const testRows = pr.map((r) => `<tr>
      <td><span class="vpill vp-${r.verdict.toLowerCase()}">${r.verdict}</span></td>
      <td class="mono">${escHtml(r.route)}</td>
      <td>${escHtml(r.testName)}</td>
      <td class="dim">${r.durationMs}ms</td>
    </tr>`).join('');
    return { ...p, pr, pp, pf, pRate, testRows };
  });

  // ── Hotspot rows ────────────────────────────────────────────────────────────
  const hotspots = summary.hotspots ?? [];
  const hotspotRowsHtml = hotspots.slice(0, 8).map((h, i) => {
    const maxRisk = hotspots[0]?.risk ?? 1;
    const pct     = Math.round((h.risk / maxRisk) * 100);
    const rColor  = pct > 75 ? '#f87171' : pct > 45 ? '#fbbf24' : '#94a3b8';
    const file    = h.file.split('/').slice(-2).join('/');
    return `<tr>
      <td style="color:var(--muted);font-size:10px;width:24px">${i + 1}</td>
      <td class="mono" title="${escHtml(h.file)}">${escHtml(file)}</td>
      <td>
        <div style="height:4px;background:var(--border);border-radius:2px;overflow:hidden;width:80px">
          <div style="height:100%;width:${pct}%;background:${rColor};border-radius:2px"></div>
        </div>
      </td>
      <td style="color:${rColor};font-weight:700;font-size:11px;text-align:right">${h.risk}</td>
      <td style="color:var(--muted);font-size:10px;text-align:right">${h.churn} commits</td>
    </tr>`;
  }).join('');

  // ── Route rows (expandable) ─────────────────────────────────────────────────
  const routeRowsHtml = routes.map((route, idx) => {
    const runs    = summary.runs.filter((r) => r.route === route);
    const hasFail = runs.some((r) => r.verdict === 'FAIL');
    const allPass = runs.every((r) => r.verdict === 'PASS');
    const st      = hasFail ? 'fail' : allPass ? 'pass' : 'warn';
    const label   = hasFail ? 'FAIL' : allPass ? 'PASS' : 'WARN';
    const avgMs   = Math.round(runs.reduce((a, r) => a + r.durationMs, 0) / runs.length);
    const failRun = runs.find((r) => r.verdict === 'FAIL');
    const innerRows = runs.map((r) => `<tr>
      <td><span class="vpill vp-${r.verdict.toLowerCase()}">${r.verdict}</span></td>
      <td>${escHtml(r.testName)}</td>
      <td class="dim">${r.durationMs}ms</td>
      ${failRun?.traceId ? '<td></td>' : ''}
    </tr>`).join('');
    return `<div class="route-item" data-idx="${idx}" data-st="${st}">
      <div class="route-row" onclick="toggleRoute(${idx})">
        <div class="rdot rdot-${st}"></div>
        <span class="route-path">${escHtml(route)}</span>
        <span class="route-avg dim">${avgMs}ms</span>
        <span class="rbadge rb-${st}">${label}</span>
        <span class="route-cnt">${runs.length} test${runs.length !== 1 ? 's' : ''}</span>
        <span class="route-chev" id="chev-${idx}">▸</span>
      </div>
      <div class="route-detail" id="detail-${idx}" style="display:none">
        <table>
          <thead><tr><th>Verdict</th><th>Test</th><th>Durée</th>${failRun?.traceId ? '<th></th>' : ''}</tr></thead>
          <tbody>${innerRows}</tbody>
        </table>
        ${failRun?.traceId ? `<div style="padding:8px 14px 10px">
          <button class="btn-patch" data-trace="${escHtml(failRun.traceId)}">👻 Auto-Patch via Ghostwriter</button>
        </div>` : ''}
      </div>
    </div>`;
  }).join('');

  // ── Triage cards ────────────────────────────────────────────────────────────
  const failedRoutes = routes.filter((r) => summary.runs.some((run) => run.route === r && run.verdict === 'FAIL'));
  const triageHtml   = failedRoutes.length === 0
    ? '<div style="padding:32px;text-align:center;color:var(--muted);font-size:13px">✅ Aucun échec — rien à triager</div>'
    : failedRoutes.map((route) => {
        const failRuns = summary.runs.filter((r) => r.route === route && r.verdict === 'FAIL');
        const failRun  = failRuns[0];
        const traceId  = failRun?.traceId ?? '';
        const isSecFail = failRun?.testName.toLowerCase().includes('attacker') || failRun?.testName.toLowerCase().includes('xss') || failRun?.testName.toLowerCase().includes('sqli');
        const verdictType = isSecFail ? 'SECURITY_BREACH' : 'SELECTOR_DRIFT';
        const verdictColor = isSecFail ? '#f87171' : '#f472b6';
        const shieldMsg = isSecFail ? 'Non absorbé — intervention requise' : 'Absorbé — bruit cosmétique probable';
        const shieldColor = isSecFail ? '#f87171' : '#4ade80';
        return `<div class="triage-card">
          <div class="triage-hd">
            <div>
              <div class="triage-route">${escHtml(route)}</div>
              <div style="font-size:10px;color:var(--muted);margin-top:2px">${failRuns.length} test${failRuns.length > 1 ? 's' : ''} en échec</div>
            </div>
            ${traceId ? `<button class="btn-patch" data-trace="${escHtml(traceId)}">👻 Auto-Patch</button>` : ''}
          </div>
          <div class="triage-rows">
            <div class="tr-row"><span class="tr-lbl">Verdict</span><span class="tr-val" style="color:${verdictColor};font-weight:600">${verdictType}</span></div>
            <div class="tr-row"><span class="tr-lbl">SHIELD</span><span class="tr-val" style="color:${shieldColor}">${shieldMsg}</span></div>
            <div class="tr-row"><span class="tr-lbl">Test</span><span class="tr-val dim">${escHtml(failRun?.testName ?? '—')}</span></div>
            ${traceId ? `<div class="tr-row"><span class="tr-lbl">Trace ID</span><span class="tr-val mono" style="font-size:10px">${escHtml(traceId)}</span></div>` : ''}
          </div>
        </div>`;
      }).join('');

  // ── All tests table ─────────────────────────────────────────────────────────
  const allTestsHtml = summary.runs.map((r) => `<tr>
    <td><span class="vpill vp-${r.verdict.toLowerCase()}">${r.verdict}</span></td>
    <td class="mono">${escHtml(r.route)}</td>
    <td>${escHtml(r.testName)}</td>
    <td class="dim">${r.durationMs}ms</td>
  </tr>`).join('');

  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>V-Infinite — IC ${ci}/100</title>
<!-- e2e-confidence-index: ${ci} -->
<style>
html,body{height:100dvh;overflow:hidden}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0f172a;--surface:#1a2236;--border:#263147;
  --text:#e2e8f0;--muted:#64748b;--subtle:#94a3b8;
  --pass:#4ade80;--fail:#f87171;--warn:#fbbf24;
  --accent:#6366f1;--accent2:#06b6d4;
}
body{font-family:-apple-system,'Segoe UI',sans-serif;background:var(--bg);color:var(--text);display:flex;flex-direction:column}

/* ── Topbar ── */
.topbar{background:var(--surface);border-bottom:1px solid var(--border);padding:0 20px;
  height:48px;display:flex;align-items:center;gap:8px;flex-shrink:0}
.brand{font-size:14px;font-weight:700;color:#fff;letter-spacing:-.3px}
.brand em{color:var(--accent);font-style:normal}
.badge{padding:2px 7px;border-radius:20px;font-size:10px;font-weight:600;letter-spacing:.4px;white-space:nowrap}
.b-mcp{background:#1e1b4b;color:#818cf8;border:1px solid #3730a3}
.b-ollama{background:#052e16;color:#4ade80;border:1px solid #166534}
.b-done{background:#042f2e;color:#2dd4bf;border:1px solid #0f766e}
.b-run{background:#1c1917;color:#fbbf24;border:1px solid #92400e}

/* ── Tab nav ── */
.nav{display:flex;align-items:center;gap:2px;margin-left:16px}
.nav-btn{
  padding:5px 12px;border-radius:6px;font-size:12px;font-weight:500;
  color:var(--muted);border:none;background:transparent;cursor:pointer;
  transition:all .15s;white-space:nowrap
}
.nav-btn:hover{color:var(--text);background:#1f2e47}
.nav-btn.active{color:#fff;background:var(--accent)}
.nav-badge{
  display:inline-block;margin-left:5px;padding:1px 5px;border-radius:10px;
  font-size:9px;font-weight:700;
}
.nb-fail{background:#2d0e0e;color:var(--fail)}
.nb-pass{background:#0a2d14;color:var(--pass)}
.nb-warn{background:#1e293b;color:var(--muted)}

.topbar-right{margin-left:auto;display:flex;align-items:center;gap:8px}
.ws-ind{display:flex;align-items:center;gap:4px;font-size:10px;color:var(--muted)}
.ws-dot{width:6px;height:6px;border-radius:50%;background:var(--muted)}
.ws-dot.live{background:var(--pass);box-shadow:0 0 4px var(--pass)}
@keyframes bl{0%,100%{opacity:1}50%{opacity:.3}}
.ws-dot.blink{animation:bl 2s infinite}
.topbar-date{font-size:10px;color:var(--muted)}

/* ── Tab pages ── */
.pages{flex:1;min-height:0;position:relative}
.page{position:absolute;inset:0;overflow-y:auto;padding:20px 24px;
  display:none;flex-direction:column;gap:16px;
  scrollbar-width:thin;scrollbar-color:var(--border) transparent}
.page.active{display:flex}

/* ── Cards / panels ── */
.card{background:var(--surface);border:1px solid var(--border);border-radius:10px;overflow:hidden}
.card-head{padding:11px 16px;border-bottom:1px solid var(--border);
  display:flex;align-items:center;justify-content:space-between;gap:8px}
.card-title{font-size:10px;font-weight:600;color:var(--subtle);text-transform:uppercase;letter-spacing:.8px}
.card-meta{font-size:10px;color:var(--muted)}

/* ── Overview hero ── */
.hero{background:var(--surface);border:1px solid var(--border);border-radius:10px;
  padding:20px 24px;display:flex;align-items:center;gap:24px}
.ci-ring{width:80px;height:80px;border-radius:50%;flex-shrink:0;
  background:${ciRing};display:flex;align-items:center;justify-content:center}
.ci-inner{width:62px;height:62px;border-radius:50%;background:var(--bg);
  display:flex;flex-direction:column;align-items:center;justify-content:center}
.ci-num{font-size:22px;font-weight:800;color:${color};line-height:1}
.ci-sub{font-size:8px;color:var(--muted);text-transform:uppercase;letter-spacing:.6px;margin-top:2px}
.metrics{display:flex;gap:20px;flex:1;flex-wrap:wrap;align-items:center}
.m{display:flex;flex-direction:column;gap:2px}
.m-val{font-size:22px;font-weight:700;line-height:1}
.m-lbl{font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px}
.c-pass{color:var(--pass)}.c-fail{color:var(--fail)}.c-warn{color:var(--warn)}
.c-blue{color:#60a5fa}.c-purple{color:#a78bfa}
.hero-cov{margin-left:auto;display:flex;flex-direction:column;align-items:flex-end;gap:4px}
.cov-lbl{font-size:10px;color:var(--muted)}
.cov-bar{height:6px;width:120px;background:var(--border);border-radius:3px;overflow:hidden}
.cov-fill{height:100%;background:linear-gradient(90deg,var(--accent),var(--accent2));border-radius:3px;width:${coveragePct}%}
.cov-pct{font-size:12px;font-weight:600;color:var(--subtle)}

/* ── 2-col grid for overview ── */
.ov-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:900px){.ov-grid{grid-template-columns:1fr}}

/* ── Route rows ── */
.route-item{border-bottom:1px solid var(--border)}
.route-item:last-child{border-bottom:none}
.route-row{
  display:grid;grid-template-columns:8px 1fr 52px 46px 52px 16px;
  gap:10px;align-items:center;padding:10px 16px;
  cursor:pointer;transition:background .12s;user-select:none
}
.route-row:hover{background:#1f2e47}
.rdot{width:7px;height:7px;border-radius:50%;flex-shrink:0}
.rdot-pass{background:var(--pass);box-shadow:0 0 5px #4ade8040}
.rdot-fail{background:var(--fail);box-shadow:0 0 5px #f8717140}
.rdot-warn{background:var(--warn);box-shadow:0 0 5px #fbbf2440}
.route-path{font-family:'SF Mono','Fira Code',monospace;font-size:12px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.route-avg{font-size:10px;text-align:right}
.rbadge{padding:2px 6px;border-radius:3px;font-size:9px;font-weight:700;letter-spacing:.5px;text-align:center}
.rb-pass{background:#0a2d14;color:var(--pass)}
.rb-fail{background:#2d0e0e;color:var(--fail)}
.rb-warn{background:#2d1f00;color:var(--warn)}
.route-cnt{font-size:10px;color:var(--muted);text-align:right}
.route-chev{font-size:10px;color:var(--muted);transition:transform .2s}
.route-chev.open{transform:rotate(90deg)}
.route-detail{background:var(--bg);border-top:1px solid var(--border)}
.route-detail table{width:100%}

/* ── Tables ── */
table{width:100%;border-collapse:collapse}
th{padding:7px 14px;text-align:left;font-size:9px;color:var(--muted);
  text-transform:uppercase;letter-spacing:.5px;background:var(--bg);border-bottom:1px solid var(--border)}
td{padding:8px 14px;border-bottom:1px solid var(--border);font-size:12px}
tr:last-child td{border-bottom:none}
tr:hover td{background:#1a2a40}
.vpill{padding:2px 6px;border-radius:3px;font-size:9px;font-weight:700;letter-spacing:.5px}
.vp-pass{background:#0a2d14;color:var(--pass)}
.vp-fail{background:#2d0e0e;color:var(--fail)}
.vp-skip{background:#1e293b;color:var(--muted)}
.mono{font-family:'SF Mono','Fira Code',monospace;font-size:11px}
.dim{color:var(--muted)}

/* ── Persona cards ── */
.persona-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
.persona-card{background:var(--surface);border:1px solid var(--border);border-radius:10px;overflow:hidden}
.persona-hd{padding:14px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px}
.persona-emoji{font-size:20px}
.persona-info{flex:1}
.persona-name{font-size:13px;font-weight:600;color:#fff}
.persona-desc{font-size:11px;color:var(--muted);margin-top:2px;line-height:1.4}
.persona-stats{display:flex;padding:12px 16px;gap:20px;background:var(--bg)}
.pstat{display:flex;flex-direction:column;gap:2px}
.pstat-val{font-size:20px;font-weight:700;line-height:1}
.pstat-lbl{font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px}
.persona-rate{margin-left:auto;display:flex;align-items:center;gap:6px}
.persona-rate-bar{height:4px;width:60px;background:var(--border);border-radius:2px;overflow:hidden}
.persona-rate-fill{height:100%;border-radius:2px}
.persona-empty{padding:16px;color:var(--muted);font-size:12px;font-style:italic}

/* ── Triage ── */
.triage-card{padding:16px;border-bottom:1px solid var(--border)}
.triage-card:last-child{border-bottom:none}
.triage-hd{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:10px;gap:12px}
.triage-route{font-family:'SF Mono','Fira Code',monospace;font-size:13px;font-weight:600;color:#fff}
.triage-rows{display:flex;flex-direction:column;gap:5px}
.tr-row{display:flex;gap:10px;align-items:baseline}
.tr-lbl{font-size:10px;color:var(--muted);width:60px;flex-shrink:0}
.tr-val{font-size:12px}

/* ── Auto-Patch btn ── */
.btn-patch{
  background:linear-gradient(135deg,#4f46e5,#7c3aed);color:#fff;border:none;
  padding:5px 12px;border-radius:5px;font-size:11px;font-weight:600;cursor:pointer;
  white-space:nowrap;flex-shrink:0
}
.btn-patch:hover{opacity:.85}
.btn-patch.loading{opacity:.5;cursor:not-allowed}
.btn-patch.success{background:linear-gradient(135deg,#059669,#10b981)}
.btn-patch.error-st{background:linear-gradient(135deg,#991b1b,#dc2626)}

/* ── Logs page ── */
.log-page{flex:1;min-height:0;font-family:'SF Mono','Fira Code',monospace;font-size:11px;
  padding:12px 16px;overflow-y:auto;
  scrollbar-width:thin;scrollbar-color:var(--border) transparent}
.le{display:flex;gap:8px;align-items:baseline;padding:2px 0;line-height:1.7}
.le-ts{color:#3d5068;flex-shrink:0;font-size:10px}
.le-ag{font-weight:700;flex-shrink:0;font-size:10px}
.ag-o{color:#60a5fa}.ag-s{color:#818cf8}.ag-a{color:#a78bfa}
.ag-c{color:#f472b6}.ag-g{color:#34d399}.ag-e{color:#fbbf24}
.le-msg{color:var(--subtle);word-break:break-word}
.log-empty{color:var(--muted);text-align:center;padding-top:40px;font-size:12px}

/* ── Footer ── */
footer{flex-shrink:0;background:var(--surface);border-top:1px solid var(--border);
  padding:7px 20px;font-size:10px;color:var(--muted);
  display:flex;justify-content:space-between;align-items:center}
</style>
</head>
<body>

<!-- ══ Topbar ══ -->
<div class="topbar">
  <span class="brand">test-end-to-end <em>V-Infinite</em></span>
  <span class="badge b-mcp">MCP</span>
  <span class="badge b-ollama">⬤ Ollama</span>
  <span class="badge b-done" id="s-pill">DONE</span>

  <nav class="nav">
    <button class="nav-btn active" onclick="showTab('overview')" id="tab-overview">Vue d'ensemble</button>
    <button class="nav-btn" onclick="showTab('routes')" id="tab-routes">
      Routes <span class="nav-badge ${failed > 0 ? 'nb-fail' : 'nb-pass'}">${routes.length}</span>
    </button>
    <button class="nav-btn" onclick="showTab('personas')" id="tab-personas">Personas</button>
    <button class="nav-btn" onclick="showTab('triage')" id="tab-triage">
      Triage ${failedRoutes.length > 0 ? `<span class="nav-badge nb-fail">${failedRoutes.length}</span>` : ''}
    </button>
    <button class="nav-btn" onclick="showTab('logs')" id="tab-logs">
      Logs <span class="nav-badge nb-warn" id="log-count">0</span>
    </button>
  </nav>

  <div class="topbar-right">
    <div class="ws-ind">
      <div class="ws-dot" id="ws-dot"></div>
      <span id="ws-status">—</span>
    </div>
    <span class="topbar-date">${genDate}</span>
  </div>
</div>

<!-- ══ Pages ══ -->
<div class="pages">

  <!-- ── Vue d'ensemble ── -->
  <div class="page active" id="page-overview">

    <div class="hero">
      <div class="ci-ring">
        <div class="ci-inner">
          <span class="ci-num">${ci}</span>
          <span class="ci-sub">IC / 100</span>
        </div>
      </div>
      <div class="metrics">
        <div class="m"><span class="m-val c-pass">${passed}</span><span class="m-lbl">Passés</span></div>
        <div class="m"><span class="m-val c-fail">${failed}</span><span class="m-lbl">Échoués</span></div>
        <div class="m"><span class="m-val c-warn">${skipped}</span><span class="m-lbl">Ignorés</span></div>
        <div class="m"><span class="m-val c-blue" id="c-val">${summary.cachedFiles}</span><span class="m-lbl">Cache hits</span></div>
        <div class="m"><span class="m-val c-purple" id="t-val">${summary.tokensSaved.toLocaleString()}</span><span class="m-lbl">Tokens écon.</span></div>
      </div>
      <div class="hero-cov">
        <span class="cov-lbl">Couverture</span>
        <div class="cov-bar"><div class="cov-fill"></div></div>
        <span class="cov-pct">${coveragePct}%</span>
      </div>
    </div>

    <div class="ov-grid">

      <!-- Résumé routes -->
      <div class="card">
        <div class="card-head">
          <span class="card-title">Routes — Aperçu rapide</span>
          <span class="card-meta">${routes.length} routes</span>
        </div>
        ${routes.slice(0, 8).map((route) => {
          const runs = summary.runs.filter((r) => r.route === route);
          const hasFail = runs.some((r) => r.verdict === 'FAIL');
          const allPass = runs.every((r) => r.verdict === 'PASS');
          const st = hasFail ? 'fail' : allPass ? 'pass' : 'warn';
          const label = hasFail ? 'FAIL' : allPass ? 'PASS' : 'WARN';
          return `<div style="display:flex;align-items:center;gap:10px;padding:9px 16px;border-bottom:1px solid var(--border)">
            <div class="rdot rdot-${st}"></div>
            <span class="route-path" style="flex:1">${escHtml(route)}</span>
            <span class="rbadge rb-${st}">${label}</span>
          </div>`;
        }).join('')}
        ${routes.length > 8 ? `<div style="padding:8px 16px;font-size:11px;color:var(--muted);text-align:center">
          +${routes.length - 8} routes — <button class="nav-btn" onclick="showTab('routes')" style="display:inline;padding:0;font-size:11px;color:var(--accent);background:none;border:none;cursor:pointer">voir tout</button>
        </div>` : ''}
      </div>

      <!-- Hotspots Git -->
      <div class="card">
        <div class="card-head">
          <span class="card-title">🧬 Hotspots Git</span>
          <span class="card-meta">${hotspots.length > 0 ? `top ${Math.min(hotspots.length, 8)} fichiers risqués` : 'mode --predictive requis'}</span>
        </div>
        ${hotspots.length > 0
          ? `<table><thead><tr><th>#</th><th>Fichier</th><th>Risque</th><th>Score</th><th>Commits</th></tr></thead><tbody>${hotspotRowsHtml}</tbody></table>`
          : '<div style="padding:24px 16px;color:var(--muted);font-size:12px">Lance <code style="background:#0f172a;border:1px solid var(--border);padding:1px 5px;border-radius:3px;font-size:11px">audit --predictive</code> pour activer l\'analyse Git forensics.</div>'
        }
      </div>

    </div>

    <!-- Toujours visible: tous les tests -->
    <div class="card">
      <div class="card-head">
        <span class="card-title">Tous les tests</span>
        <span class="card-meta">${total} tests · ${passed} passés · ${failed} échoués</span>
      </div>
      <table>
        <thead><tr><th>Verdict</th><th>Route</th><th>Test</th><th>Durée</th></tr></thead>
        <tbody>${allTestsHtml}</tbody>
      </table>
    </div>

  </div>

  <!-- ── Routes ── -->
  <div class="page" id="page-routes">
    <div class="card">
      <div class="card-head">
        <span class="card-title">Route Impact Map</span>
        <span class="card-meta">${routes.length} routes · ${total} tests — cliquer pour détailler</span>
      </div>
      ${routeRowsHtml}
    </div>
  </div>

  <!-- ── Personas ── -->
  <div class="page" id="page-personas">
    <div class="persona-grid">
      ${personaData.map((p) => `<div class="persona-card">
        <div class="persona-hd">
          <span class="persona-emoji">${p.emoji}</span>
          <div class="persona-info">
            <div class="persona-name" style="color:${p.color}">${p.label}</div>
            <div class="persona-desc">${p.desc}</div>
          </div>
        </div>
        <div class="persona-stats">
          <div class="pstat"><span class="pstat-val c-pass">${p.pp}</span><span class="pstat-lbl">Pass</span></div>
          <div class="pstat"><span class="pstat-val c-fail">${p.pf}</span><span class="pstat-lbl">Fail</span></div>
          <div class="pstat"><span class="pstat-val dim">${p.pr.length}</span><span class="pstat-lbl">Total</span></div>
          <div class="persona-rate">
            <div class="persona-rate-bar">
              <div class="persona-rate-fill" style="width:${p.pRate}%;background:${p.color}"></div>
            </div>
            <span style="font-size:11px;color:${p.color};font-weight:600">${p.pRate}%</span>
          </div>
        </div>
        ${p.pr.length > 0
          ? `<div style="border-top:1px solid var(--border)">
              <table><thead><tr><th>Verdict</th><th>Route</th><th>Test</th><th>Durée</th></tr></thead>
              <tbody>${p.testRows}</tbody></table>
            </div>`
          : `<div class="persona-empty">Aucun test de ce profil détecté.<br>Utilise <code style="font-size:10px">--level=3</code> ou nomme tes tests avec "${p.key}".</div>`
        }
      </div>`).join('')}
    </div>
  </div>

  <!-- ── Triage ── -->
  <div class="page" id="page-triage">
    <div class="card" style="${failedRoutes.length > 0 ? 'border-color:#3b2060' : ''}">
      <div class="card-head" style="${failedRoutes.length > 0 ? 'background:#1a0f2e;border-color:#3b2060' : ''}">
        <span class="card-title" style="${failedRoutes.length > 0 ? 'color:#a78bfa' : ''}">Triage Coroner</span>
        <span class="card-meta">${failedRoutes.length > 0 ? `${failedRoutes.length} route${failedRoutes.length > 1 ? 's' : ''} analysée${failedRoutes.length > 1 ? 's' : ''}` : 'Aucun échec'}</span>
      </div>
      ${triageHtml}
    </div>
  </div>

  <!-- ── Logs ── -->
  <div class="page" id="page-logs" style="padding:0">
    <div style="background:var(--surface);border-bottom:1px solid var(--border);padding:10px 16px;
      display:flex;align-items:center;justify-content:space-between;flex-shrink:0">
      <span style="font-size:10px;font-weight:600;color:var(--subtle);text-transform:uppercase;letter-spacing:.8px">Log en direct</span>
      <div style="display:flex;gap:8px;align-items:center">
        <div class="ws-ind"><div class="ws-dot" id="ws-dot2"></div><span id="ws-status2">—</span></div>
        <a href="/api/log" target="_blank" download="latest.log"
          style="font-size:10px;color:var(--muted);background:none;border:1px solid var(--border);padding:2px 8px;border-radius:4px;cursor:pointer;text-decoration:none">⬇ Télécharger</a>
        <button onclick="document.getElementById('log-area').innerHTML='<div class=log-empty>Log vidé.</div>';logCount=0;document.getElementById(\'log-count\').textContent=\'0\'"
          style="font-size:10px;color:var(--muted);background:none;border:1px solid var(--border);padding:2px 8px;border-radius:4px;cursor:pointer">Vider</button>
      </div>
    </div>
    <div style="flex:1;min-height:0;display:flex;gap:0;overflow:hidden">
      <div class="log-page" id="log-area" style="flex:1;border-right:1px solid var(--border)">
        <div class="log-empty">En attente de connexion WebSocket…</div>
      </div>
      <div id="ss-area" style="width:320px;overflow-y:auto;flex-shrink:0;
        scrollbar-width:thin;scrollbar-color:var(--border) transparent">
        <div class="ss-empty" style="padding:24px 16px;text-align:center;color:var(--muted);font-size:11px">
          Screenshots SHIELD<br>apparaîtront ici<br>lors du triage Coroner.
        </div>
      </div>
    </div>
  </div>

</div>

<footer>
  <span>test-end-to-end V-Infinite 2.0.0</span>
  <span>IC ${ci}/100 · ${passed}/${total} passés · ${new Date().toLocaleDateString('fr-FR')}</span>
</footer>

<script>
(function(){
  // ── Tab routing ──────────────────────────────────────────────────────────
  var tabs = ['overview','routes','personas','triage','logs'];
  window.showTab = function(id){
    tabs.forEach(function(t){
      var p = document.getElementById('page-'+t);
      var b = document.getElementById('tab-'+t);
      if(p) p.classList.toggle('active', t===id);
      if(b) b.classList.toggle('active', t===id);
    });
    location.hash = id === 'overview' ? '' : id;
  };
  var h = location.hash.replace('#','');
  if(h && tabs.includes(h)) showTab(h);

  // ── Route expand/collapse ────────────────────────────────────────────────
  window.toggleRoute = function(idx){
    var d = document.getElementById('detail-'+idx);
    var c = document.getElementById('chev-'+idx);
    if(!d) return;
    var open = d.style.display === 'none';
    d.style.display = open ? 'block' : 'none';
    if(c) c.classList.toggle('open', open);
  };

  // ── WebSocket ────────────────────────────────────────────────────────────
  var proto = location.protocol==='https:'?'wss:':'ws:';
  var AC    = {orch:'ag-o',scout:'ag-s',artisan:'ag-a',coroner:'ag-c',ghost:'ag-g',ghostwriter:'ag-g',evolver:'ag-e'};
  var spl   = document.getElementById('s-pill');
  var logEl = document.getElementById('log-area');
  window.logCount = 0;

  function syncDots(live){
    ['ws-dot','ws-dot2'].forEach(function(id){
      var d = document.getElementById(id);
      if(d){ d.className = 'ws-dot'+(live?' live blink':''); }
    });
    ['ws-status','ws-status2'].forEach(function(id){
      var s = document.getElementById(id);
      if(s) s.textContent = live ? 'Connecté' : 'Déconnecté';
    });
  }

  var screenshotArea = document.getElementById('ss-area');
  function addScreenshot(label, b64){
    if(!screenshotArea) return;
    var wrap = document.createElement('div');
    wrap.style.cssText = 'padding:10px 16px;border-bottom:1px solid var(--border)';
    var lbl = document.createElement('div');
    lbl.style.cssText = 'font-size:10px;color:var(--muted);margin-bottom:6px;text-transform:uppercase;letter-spacing:.6px';
    lbl.textContent = label;
    var img = document.createElement('img');
    img.src = 'data:image/png;base64,'+b64;
    img.style.cssText = 'max-width:100%;border-radius:4px;border:1px solid var(--border)';
    wrap.append(lbl, img);
    screenshotArea.appendChild(wrap);
    if(screenshotArea.querySelector('.ss-empty')) screenshotArea.querySelector('.ss-empty').remove();
    // Switch to logs tab to show screenshot
    showTab('logs');
  }

  function addLog(ts, ag, msg){
    if(logEl.querySelector('.log-empty')) logEl.innerHTML = '';
    var r = document.createElement('div'); r.className = 'le';
    var t = document.createElement('span'); t.className = 'le-ts';
    t.textContent = new Date(ts).toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
    var a = document.createElement('span');
    var k = Object.keys(AC).find(function(k){ return ag && ag.includes(k); });
    a.className = 'le-ag '+(k?AC[k]:'ag-o');
    a.textContent = ag?'['+ag+']':'[—]';
    var m = document.createElement('span'); m.className = 'le-msg'; m.textContent = msg;
    r.append(t,a,m); logEl.appendChild(r); logEl.scrollTop = logEl.scrollHeight;
    window.logCount++;
    document.getElementById('log-count').textContent = window.logCount;
  }

  function parseLine(raw){
    var m = raw.match(/\\[(\\w+)[\\s\\d:]+\\]\\s?(?:\\[([\\w-]+)\\]\\s)?(.+)/);
    if(m) return {ag:m[2]||'orch',msg:m[3]};
    return {ag:'orch',msg:raw};
  }

  function connect(){
    try {
      var ws = new WebSocket(proto+'//'+location.host+'/ws');
      ws.onopen  = function(){ syncDots(true); };
      ws.onclose = function(){ syncDots(false); setTimeout(connect, 3000); };
      ws.onmessage = function(e){
        var ev = JSON.parse(e.data);
        if(ev.type==='LOG'){ var p=parseLine(String(ev.payload)); addLog(ev.ts,p.ag,p.msg); }
        if(ev.type==='STATE'){ spl.textContent=ev.payload; spl.className='badge '+(ev.payload==='DONE'?'b-done':'b-run'); }
        if(ev.type==='METRIC'){
          var k=ev.payload.key, v=ev.payload.value;
          if(k==='cachedFiles'){ var el=document.getElementById('c-val'); if(el)el.textContent=v; }
          if(k==='tokensSaved'){ var el=document.getElementById('t-val'); if(el)el.textContent=v; }
        }
        if(ev.type==='SCREENSHOT'){ addScreenshot(ev.payload.label, ev.payload.b64Png); }
        if(ev.type==='REPORT_READY') location.reload();
      };
    } catch(_){ syncDots(false); }
  }
  connect();

  // ── Auto-Patch buttons ───────────────────────────────────────────────────
  document.querySelectorAll('.btn-patch').forEach(function(btn){
    btn.addEventListener('click', function(){
      if(btn.classList.contains('loading')) return;
      btn.classList.add('loading'); btn.textContent = '⏳ En cours…';
      fetch('/api/repair',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({traceId:btn.dataset.trace})
      })
      .then(function(r){ return r.ok ? r.json() : r.json().then(function(d){ throw new Error(d.error||'Erreur serveur'); }); })
      .then(function(){
        btn.classList.remove('loading'); btn.classList.add('success'); btn.textContent='✓ Queued';
        addLog(Date.now(),'ghost','Réparation déclenchée — traceId: '+btn.dataset.trace);
      })
      .catch(function(e){
        btn.classList.remove('loading'); btn.classList.add('error-st');
        btn.textContent='✗ '+e.message.slice(0,30);
        setTimeout(function(){ btn.classList.remove('error-st'); btn.textContent='👻 Auto-Patch'; }, 4000);
      });
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
  // Init log file for this run
  const workDir = join(targetPath, '.e2e-work');
  try {
    mkdirSync(workDir, { recursive: true });
    _logPath = join(workDir, 'latest.log');
    appendFileSync(_logPath, `\n${'═'.repeat(60)}\nRun: ${new Date().toISOString()}\n${'═'.repeat(60)}\n`, 'utf-8');
  } catch { /* non-fatal */ }

  // Intercept console.log so ALL agent + orchestrator output goes to WS + log file
  const _origLog = console.log.bind(console);
  console.log = (...args: unknown[]) => {
    const msg = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    broadcast({ type: 'LOG', payload: msg, ts: Date.now() });
    persistLine(msg);
    _origLog(...args);
  };

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

  app.get('/api/log', (_req: Request, res: Response) => {
    const logPath = join(targetPath, '.e2e-work', 'latest.log');
    if (!existsSync(logPath)) {
      res.status(404).json({ error: 'No log yet — launch an audit first.' });
      return;
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(readFileSync(logPath, 'utf-8'));
  });

  // ── Metrics API (SQLite) ────────────────────────────────────────────────────

  app.get('/api/metrics', (_req: Request, res: Response) => {
    import('../utils/metricsTracker.js').then(({ getStats }) => {
      res.json(getStats(targetPath));
    }).catch((e) => res.status(500).json({ error: (e as Error).message }));
  });

  app.get('/api/runs', (req: Request, res: Response) => {
    const limit = parseInt((req.query['limit'] as string) ?? '20', 10);
    import('../utils/metricsTracker.js').then(({ getRecentRuns }) => {
      res.json(getRecentRuns(limit, targetPath));
    }).catch((e) => res.status(500).json({ error: (e as Error).message }));
  });

  app.get('/api/triages', (req: Request, res: Response) => {
    const limit = parseInt((req.query['limit'] as string) ?? '20', 10);
    import('../utils/metricsTracker.js').then(({ getRecentTriages }) => {
      res.json(getRecentTriages(limit, targetPath));
    }).catch((e) => res.status(500).json({ error: (e as Error).message }));
  });

  app.get('/api/arch', (_req: Request, res: Response) => {
    const archPath = join(targetPath, '.e2e-work', 'arch-report.json');
    if (!existsSync(archPath)) {
      res.status(404).json({ error: 'No arch report yet — run: node dist/index.js arch <path>' });
      return;
    }
    res.json(JSON.parse(readFileSync(archPath, 'utf-8')));
  });

  app.get('/api/dependabot', (_req: Request, res: Response) => {
    const depPath = join(targetPath, '.e2e-work', 'dependabot-report.json');
    if (!existsSync(depPath)) {
      res.status(404).json({ error: 'No dependabot report yet — run: npm run security-fix' });
      return;
    }
    res.json(JSON.parse(readFileSync(depPath, 'utf-8')));
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
