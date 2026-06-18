/**
 * coverage.ts — Route/form/API coverage map agent.
 *
 * Reads existing test files in tests/ and cross-references them against
 * the route map produced by the Scout. Outputs a structured coverage
 * report with % per category and an HTML summary.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';

import type { AgentTask, RouteMap, RunConfig } from '../orchestrator.js';

interface OllamaCapability {
  available: boolean;
  model: string | null;
  endpoint: string;
}

export interface CoverageEntry {
  route: string;
  method: string;
  covered: boolean;
  testFiles: string[];
}

export interface FormCoverageEntry {
  action: string;
  covered: boolean;
  testFiles: string[];
}

export interface CoverageReport {
  routes: CoverageEntry[];
  forms: FormCoverageEntry[];
  routeCoverage: number;
  formCoverage: number;
  totalCoverage: number;
  gaps: string[];
}

// ── Collect all spec files under tests/ ───────────────────────────────────────

function collectTestFiles(testsDir: string): string[] {
  if (!existsSync(testsDir)) return [];
  const results: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        walk(full);
      } else if (entry.isFile() && /\.(spec|test)\.(ts|js|py|rb|feature)$/.test(entry.name)) {
        results.push(full);
      }
    }
  };
  walk(testsDir);
  return results;
}

// ── Match route to test files ─────────────────────────────────────────────────

function slugify(path: string): string {
  return path.replace(/[^a-z0-9]/gi, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').toLowerCase();
}

function routeMatchesFile(route: string, fileContent: string, fileName: string): boolean {
  const slug = slugify(route);

  // Direct route string in file content
  if (fileContent.includes(`'${route}'`) || fileContent.includes(`"${route}"`)) return true;
  // Slug-based filename match
  if (fileName.toLowerCase().includes(slug)) return true;
  // Regex match for dynamic segments (/user/:id → /user/)
  const prefix = route.split(':')[0].replace(/\/$/, '');
  if (prefix.length > 1 && fileContent.includes(prefix)) return true;

  return false;
}

// ── Generate coverage HTML ────────────────────────────────────────────────────

function generateCoverageHtml(report: CoverageReport, targetPath: string): void {
  const routeRows = report.routes.map((r) => `
    <tr>
      <td><span class="badge ${r.covered ? 'b-pass' : 'b-fail'}">${r.covered ? 'COV' : 'GAP'}</span></td>
      <td class="mono">${r.method.toUpperCase()}</td>
      <td class="mono">${r.route}</td>
      <td>${r.testFiles.map((f) => `<span class="chip">${basename(f)}</span>`).join(' ') || '<span class="none">—</span>'}</td>
    </tr>`).join('');

  const formRows = report.forms.map((f) => `
    <tr>
      <td><span class="badge ${f.covered ? 'b-pass' : 'b-fail'}">${f.covered ? 'COV' : 'GAP'}</span></td>
      <td class="mono" colspan="2">${f.action}</td>
      <td>${f.testFiles.map((t) => `<span class="chip">${basename(t)}</span>`).join(' ') || '<span class="none">—</span>'}</td>
    </tr>`).join('');

  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>V-Infinite — Couverture ${report.totalCoverage}%</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,sans-serif;background:#0f172a;color:#e2e8f0;padding:32px;line-height:1.5}
h1{font-size:20px;font-weight:700;color:#fff;margin-bottom:4px}
.sub{font-size:13px;color:#64748b;margin-bottom:28px}
.stats{display:flex;gap:16px;margin-bottom:28px;flex-wrap:wrap}
.stat{background:#1e293b;border:1px solid #263147;border-radius:10px;padding:16px 24px;min-width:140px}
.stat-n{font-size:28px;font-weight:800;line-height:1}
.stat-l{font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.5px;margin-top:3px}
.c-g{color:#4ade80}.c-r{color:#f87171}.c-b{color:#60a5fa}
.section{background:#1e293b;border:1px solid #263147;border-radius:10px;overflow:hidden;margin-bottom:20px}
.sh{padding:12px 18px;border-bottom:1px solid #263147;font-size:11px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:.8px}
table{width:100%;border-collapse:collapse}
th{padding:8px 18px;text-align:left;font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:.5px;background:#0f172a;border-bottom:1px solid #263147}
td{padding:9px 18px;border-bottom:1px solid #1a2236;font-size:12px}
tr:last-child td{border-bottom:none}
tr:hover td{background:#1f2e47}
.badge{padding:2px 7px;border-radius:4px;font-size:9px;font-weight:700;letter-spacing:.5px}
.b-pass{background:#052e16;color:#4ade80}.b-fail{background:#2d0e0e;color:#f87171}
.mono{font-family:'SF Mono','Fira Code',monospace;font-size:11px}
.chip{background:#0f172a;border:1px solid #334155;padding:1px 6px;border-radius:3px;font-size:10px;font-family:monospace;margin-right:3px;color:#94a3b8}
.none{color:#3d5068;font-size:11px}
.gaps{background:#1a0f2e;border:1px solid #3b2060;border-radius:10px;padding:16px 20px;margin-bottom:20px}
.gap-title{font-size:11px;font-weight:600;color:#a78bfa;text-transform:uppercase;letter-spacing:.8px;margin-bottom:10px}
.gap-item{font-family:monospace;font-size:12px;color:#f87171;padding:2px 0}
.gap-item::before{content:'✗  ';color:#64748b}
footer{margin-top:24px;font-size:11px;color:#3d5068;text-align:center}
</style>
</head>
<body>
<h1>test-end-to-end V-Infinite — Rapport de couverture</h1>
<div class="sub">Généré le ${new Date().toLocaleString('fr-FR')} · ${targetPath}</div>

<div class="stats">
  <div class="stat"><div class="stat-n c-b">${report.totalCoverage}%</div><div class="stat-l">Couverture totale</div></div>
  <div class="stat"><div class="stat-n c-g">${report.routeCoverage}%</div><div class="stat-l">Routes couvertes</div></div>
  <div class="stat"><div class="stat-n c-g">${report.formCoverage}%</div><div class="stat-l">Forms couverts</div></div>
  <div class="stat"><div class="stat-n c-r">${report.gaps.length}</div><div class="stat-l">Gaps identifiés</div></div>
</div>

${report.gaps.length > 0 ? `<div class="gaps">
  <div class="gap-title">Routes / forms sans test</div>
  ${report.gaps.map((g) => `<div class="gap-item">${g}</div>`).join('')}
</div>` : ''}

<div class="section">
  <div class="sh">Routes (${report.routes.filter((r) => r.covered).length}/${report.routes.length} couvertes)</div>
  <table>
    <thead><tr><th>Statut</th><th>Méthode</th><th>Route</th><th>Fichiers de test</th></tr></thead>
    <tbody>${routeRows}</tbody>
  </table>
</div>

${report.forms.length > 0 ? `<div class="section">
  <div class="sh">Formulaires (${report.forms.filter((f) => f.covered).length}/${report.forms.length} couverts)</div>
  <table>
    <thead><tr><th>Statut</th><th>Action</th><th></th><th>Fichiers de test</th></tr></thead>
    <tbody>${formRows}</tbody>
  </table>
</div>` : ''}

<footer>test-end-to-end V-Infinite 2.0.0 · e2e-coverage</footer>
</body>
</html>`;

  const outDir = join(targetPath, '.e2e-work');
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, 'coverage.html');
  writeFileSync(outPath, html, 'utf-8');
  console.log(`[coverage] report → ${outPath}`);
}

// ── Main agent entry point ────────────────────────────────────────────────────

export async function run(
  task: AgentTask,
  config: RunConfig,
  _ollama: OllamaCapability | null,
): Promise<CoverageReport> {
  if (task.type !== 'SCAN_AST') {
    throw new Error(`coverage received unexpected task type: ${task.type}`);
  }

  // Re-run scout to get current route map
  const { run: scoutRun } = await import('./scout.js') as { run: (t: AgentTask, c: RunConfig, o: OllamaCapability | null) => Promise<RouteMap> };
  const routeMap = await scoutRun(task, config, _ollama);

  const testsDir = join(config.targetPath, 'tests');
  const testFiles = collectTestFiles(testsDir);
  const fileContents = new Map<string, string>();

  for (const tf of testFiles) {
    try {
      fileContents.set(tf, readFileSync(tf, 'utf-8'));
    } catch { /* skip unreadable */ }
  }

  // ── Route coverage ──────────────────────────────────────────────────────────
  const routeCoverage: CoverageEntry[] = routeMap.routes.map((r) => {
    const matched = testFiles.filter((tf) => {
      const content = fileContents.get(tf) ?? '';
      return routeMatchesFile(r.path, content, basename(tf));
    });
    return {
      route: r.path,
      method: r.method,
      covered: matched.length > 0,
      testFiles: matched,
    };
  });

  // ── Form coverage ───────────────────────────────────────────────────────────
  const formCoverage: FormCoverageEntry[] = routeMap.forms.map((f) => {
    const matched = testFiles.filter((tf) => {
      const content = fileContents.get(tf) ?? '';
      return routeMatchesFile(f.action, content, basename(tf));
    });
    return {
      action: f.action,
      covered: matched.length > 0,
      testFiles: matched,
    };
  });

  // ── Stats ───────────────────────────────────────────────────────────────────
  const routePct = routeCoverage.length === 0 ? 100
    : Math.round((routeCoverage.filter((r) => r.covered).length / routeCoverage.length) * 100);
  const formPct = formCoverage.length === 0 ? 100
    : Math.round((formCoverage.filter((f) => f.covered).length / formCoverage.length) * 100);
  const totalPct = Math.round((routePct + formPct) / 2);

  const gaps = [
    ...routeCoverage.filter((r) => !r.covered).map((r) => `${r.method.toUpperCase()} ${r.route}`),
    ...formCoverage.filter((f) => !f.covered).map((f) => `FORM ${f.action}`),
  ];

  const report: CoverageReport = {
    routes: routeCoverage,
    forms: formCoverage,
    routeCoverage: routePct,
    formCoverage: formPct,
    totalCoverage: totalPct,
    gaps,
  };

  // Console summary
  console.log(`[coverage] routes: ${routePct}% · forms: ${formPct}% · total: ${totalPct}%`);
  if (gaps.length > 0) {
    console.log(`[coverage] gaps (${gaps.length}):`);
    gaps.forEach((g) => console.log(`  ✗  ${g}`));
  } else {
    console.log('[coverage] ✓ couverture complète');
  }

  // --detail: print per-route matched test files
  if (config.detail) {
    console.log('\n[coverage] détail par route :');
    routeCoverage.forEach((r) => {
      const status = r.covered ? '✓' : '✗';
      console.log(`  ${status}  ${r.method.toUpperCase()} ${r.route}`);
      r.testFiles.forEach((f) => console.log(`       → ${f.replace(config.targetPath, '.')}`));
    });
    console.log('\n[coverage] détail par formulaire :');
    formCoverage.forEach((f) => {
      const status = f.covered ? '✓' : '✗';
      console.log(`  ${status}  FORM ${f.action}`);
      f.testFiles.forEach((tf) => console.log(`       → ${tf.replace(config.targetPath, '.')}`));
    });
  }

  generateCoverageHtml(report, config.targetPath);

  // Persist JSON for other agents
  const jsonPath = join(config.targetPath, '.e2e-work', 'coverage.json');
  writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf-8');

  return report;
}
