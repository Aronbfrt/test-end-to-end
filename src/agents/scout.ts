/**
 * scout.ts — Global mapping agent.
 *
 * Three responsibilities:
 *  1. AST_SCAN     : Parse TypeScript/JavaScript source with ts-morph to extract
 *                    routes, forms, exported functions and build an impact graph.
 *  2. DOC_ALIGN    : Read README.md + /docs/ and cross-check features described
 *                    in prose against routes found in the AST. Surface divergences.
 *  3. GIT_FORENSICS : (--predictive only) Run `git log` on 12 months, classify
 *                    commits by stress markers, cross-weight with file churn to
 *                    produce Psychological Code Hotspot rankings.
 */

import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, join, extname, basename } from 'node:path';
import { Project, SourceFile, SyntaxKind, Node, StringLiteral } from 'ts-morph';

import type { AgentTask, RouteMap, RunConfig } from '../orchestrator.js';
import { ollamaInfer } from '../orchestrator.js';

// ── Types ──────────────────────────────────────────────────────────────────────

interface OllamaCapability {
  available: boolean;
  model: string | null;
  endpoint: string;
}

interface Route {
  method: string;
  path: string;
  handler?: string;
  file?: string;
  line?: number;
}

interface Form {
  action: string;
  method: string;
  fields: string[];
  file?: string;
}

interface DocFeature {
  headline: string;
  /** Verbs + nouns extracted from the description. */
  keywords: string[];
  source: string;
}

interface AlignmentAlert {
  type: 'DOC_NO_ROUTE' | 'ROUTE_NO_DOC';
  description: string;
  feature?: string;
  route?: string;
}

export interface ScanResult extends RouteMap {
  stack: string;
  routes: Route[];
  forms: Form[];
  docFeatures: DocFeature[];
  alignmentAlerts: AlignmentAlert[];
  hotspots: HotspotEntry[];
  impactGraph: Record<string, string[]>;
}

interface CommitEntry {
  hash: string;
  ts: number;
  hour: number;
  message: string;
  files: string[];
  stressScore: number;
}

export interface HotspotEntry {
  file: string;
  churnCount: number;
  stressScore: number;
  riskScore: number;
  topCommits: string[];
}

// ── Stack detection ────────────────────────────────────────────────────────────

function detectStack(root: string): string {
  const pkg = join(root, 'package.json');
  if (existsSync(pkg)) {
    try {
      const p = JSON.parse(readFileSync(pkg, 'utf-8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const deps = { ...p.dependencies, ...p.devDependencies };
      if (deps['next'])       return 'next.js';
      if (deps['nuxt'])       return 'nuxt';
      if (deps['@angular/core']) return 'angular';
      if (deps['svelte'])     return 'svelte';
      if (deps['express'])    return 'express';
      if (deps['fastify'])    return 'fastify';
      if (deps['react'])      return 'react';
      if (deps['vue'])        return 'vue';
    } catch (e) { console.warn(`[scout] package.json parse failed: ${(e as Error).message}`); }
  }
  if (existsSync(join(root, 'artisan')))         return 'laravel';
  if (existsSync(join(root, 'manage.py')))       return 'django';
  if (existsSync(join(root, 'config/routes.rb'))) return 'rails';
  if (existsSync(join(root, 'go.mod')))          return 'go';
  if (existsSync(join(root, 'composer.json')))   return 'php';
  return 'unknown';
}

// ── AST route extraction (ts-morph) ───────────────────────────────────────────

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all', 'use']);

/**
 * Extract Express-style route registrations from a source file.
 * Pattern: app.get('/path', handler) | router.post('/path', …)
 */
function extractExpressRoutes(sf: SourceFile): Route[] {
  const routes: Route[] = [];
  sf.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return;
    const expr = node.getExpression();
    if (!Node.isPropertyAccessExpression(expr)) return;

    const method = expr.getName().toLowerCase();
    if (!HTTP_METHODS.has(method)) return;

    const args = node.getArguments();
    if (args.length < 1) return;

    const pathArg = args[0]!;
    if (!Node.isStringLiteral(pathArg)) return;

    const handler = args[1]
      ? (Node.isIdentifier(args[1]) ? args[1].getText() : '<inline>')
      : undefined;

    routes.push({
      method: method.toUpperCase(),
      path: (pathArg as StringLiteral).getLiteralValue(),
      handler,
      file: sf.getFilePath(),
      line: pathArg.getStartLineNumber(),
    });
  });
  return routes;
}

/**
 * Extract Next.js App Router route segments from file paths.
 * /app/dashboard/page.tsx → GET /dashboard
 */
function extractNextRoutes(files: string[], root: string): Route[] {
  const routes: Route[] = [];
  for (const f of files) {
    const rel = f.replace(root, '');
    const appMatch = rel.match(/[/\\]app([/\\].+?)[/\\](page|route)\.(tsx?|jsx?)$/);
    if (!appMatch) continue;

    let segment = appMatch[1]!
      .replace(/\\/g, '/')
      .replace(/\/\(.*?\)/g, '')        // remove route groups
      .replace(/\[\.\.\.(.+?)\]/g, '*') // catch-all segments
      .replace(/\[(.+?)\]/g, ':$1');    // dynamic segments

    if (!segment) segment = '/';

    // route.ts files can define specific methods; page.tsx is GET
    const isRoute = basename(f).startsWith('route');
    routes.push({ method: isRoute ? 'ANY' : 'GET', path: segment, file: f });
  }
  return routes;
}

/**
 * Extract form elements from HTML/JSX source text.
 * Works on .tsx/.jsx/.html — looks for <form action= method= > patterns.
 */
function extractForms(content: string, filePath: string): Form[] {
  const forms: Form[] = [];
  const formRe = /<form([^>]*)>([\s\S]*?)<\/form>/gi;
  let fm: RegExpExecArray | null;

  while ((fm = formRe.exec(content)) !== null) {
    const attrs = fm[1] ?? '';
    const body  = fm[2] ?? '';

    const actionM = attrs.match(/action=["']([^"']+)["']/i);
    const methodM = attrs.match(/method=["']([^"']+)["']/i);

    const fields: string[] = [];
    const inputRe = /<input[^>]*name=["']([^"']+)["'][^>]*>/gi;
    let inp: RegExpExecArray | null;
    while ((inp = inputRe.exec(body)) !== null) fields.push(inp[1]!);

    forms.push({
      action: actionM?.[1] ?? '#',
      method: (methodM?.[1] ?? 'GET').toUpperCase(),
      fields,
      file: filePath,
    });
  }
  return forms;
}

// ── Impact graph ───────────────────────────────────────────────────────────────

/**
 * Build a shallow import dependency graph.
 * For each file, list the local modules it imports from.
 */
function buildImpactGraph(files: string[], root: string): Record<string, string[]> {
  const graph: Record<string, string[]> = {};
  const importRe = /(?:import|from)\s+['"](\.[^'"]+)['"]/g;

  for (const f of files) {
    let src: string;
    try { src = readFileSync(f, 'utf-8'); } catch { continue; }

    const deps: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = importRe.exec(src)) !== null) {
      deps.push(m[1]!);
    }
    importRe.lastIndex = 0;
    graph[f.replace(root + '/', '')] = deps;
  }
  return graph;
}

// ── Documentation alignment ────────────────────────────────────────────────────

/**
 * Extract feature descriptions from markdown text.
 * Treats H2/H3 headings as feature boundaries, collects body text per section.
 */
function parseMarkdownFeatures(md: string, sourcePath: string): DocFeature[] {
  const features: DocFeature[] = [];
  const lines = md.split('\n');
  let currentHeadline = '';
  let currentBody = '';

  const flush = () => {
    if (!currentHeadline) return;
    const keywords = extractKeywords(currentHeadline + ' ' + currentBody);
    if (keywords.length > 0) {
      features.push({ headline: currentHeadline, keywords, source: sourcePath });
    }
  };

  for (const line of lines) {
    const h = line.match(/^#{2,3}\s+(.+)/);
    if (h) {
      flush();
      currentHeadline = h[1]!.trim();
      currentBody = '';
    } else {
      currentBody += ' ' + line;
    }
  }
  flush();
  return features;
}

function extractKeywords(text: string): string[] {
  // Extract meaningful nouns/verbs — strip markdown syntax, code, URLs
  const clean = text
    .replace(/`[^`]+`/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .toLowerCase();

  const words = clean.match(/\b[a-z]{4,}\b/g) ?? [];
  const stopwords = new Set([
    'this', 'that', 'with', 'from', 'have', 'will', 'your', 'more', 'when',
    'than', 'into', 'also', 'some', 'their', 'which', 'about', 'after',
    'before', 'should', 'would', 'could', 'using', 'used', 'each',
  ]);
  return [...new Set(words.filter((w) => !stopwords.has(w)))].slice(0, 15);
}

function readDocsDir(docsPath: string): Array<{ path: string; content: string }> {
  if (!existsSync(docsPath)) return [];
  const result: Array<{ path: string; content: string }> = [];
  try {
    const entries = readdirSync(docsPath, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && /\.(md|txt|rst)$/.test(e.name)) {
        const p = join(docsPath, e.name);
        result.push({ path: p, content: readFileSync(p, 'utf-8') });
      }
    }
  } catch { /* unreadable dir */ }
  return result;
}

/**
 * Match doc features against discovered routes.
 * A feature is "unimplemented" when none of its keywords appear in any route path.
 * A route is "undocumented" when no feature mentions the route path fragment.
 */
function crossCheck(features: DocFeature[], routes: Route[]): AlignmentAlert[] {
  const alerts: AlignmentAlert[] = [];
  const routePaths = routes.map((r) => r.path.toLowerCase());

  for (const feat of features) {
    const covered = feat.keywords.some((kw) =>
      routePaths.some((rp) => rp.includes(kw)),
    );
    if (!covered) {
      alerts.push({
        type: 'DOC_NO_ROUTE',
        description: `Feature "${feat.headline}" documented but no matching route found`,
        feature: feat.headline,
      });
    }
  }

  for (const route of routes) {
    const seg = route.path.replace(/[:*]/g, '').replace(/\//g, ' ').trim();
    const segs = seg.split(/\s+/).filter((s) => s.length > 2);
    const documented = segs.some((s) =>
      features.some((f) => f.keywords.includes(s)),
    );
    if (!documented && route.path !== '/') {
      alerts.push({
        type: 'ROUTE_NO_DOC',
        description: `Route ${route.method} ${route.path} has no documentation`,
        route: route.path,
      });
    }
  }

  return alerts;
}

// ── Git forensics ──────────────────────────────────────────────────────────────

/**
 * Stress markers in commit messages that correlate with higher bug density.
 * Score per match: positive = more stress, additive.
 */
const STRESS_PATTERNS: Array<{ re: RegExp; score: number; label: string }> = [
  { re: /\b(fix|hotfix|urgent|emergency|critical|asap|prod bug)\b/i, score: 3, label: 'hotfix' },
  { re: /\b(wip|temp|temporary|hack|dirty|quick|kludge)\b/i,        score: 2, label: 'wip'    },
  { re: /\b(crap|damn|shit|wtf|ugh|argh|ffs|stupid)\b/i,            score: 3, label: 'expletive' },
  { re: /\b(revert|rollback|undo|broke|broken|oops)\b/i,             score: 2, label: 'revert' },
  { re: /!{2,}/,                                                      score: 1, label: 'exclamation' },
  { re: /\bno\s+time\b|\bjust\s+ship\b|\bship\s+it\b/i,             score: 2, label: 'rush'   },
];

function scoreCommitMessage(msg: string): number {
  return STRESS_PATTERNS.reduce((acc, p) => acc + (p.re.test(msg) ? p.score : 0), 0);
}

function isLateNight(hour: number): boolean {
  return hour >= 23 || hour <= 4;
}

/**
 * Run git log for the past 12 months and return structured commit data.
 * Format: HASH|UNIX_TS|HOUR|MESSAGE
 */
function fetchGitLog(root: string): CommitEntry[] {
  const since = new Date();
  since.setFullYear(since.getFullYear() - 1);
  const sinceStr = since.toISOString().split('T')[0]!;

  let raw: string;
  try {
    raw = execSync(
      `git -C "${root}" log --since="${sinceStr}" --name-only --pretty=format:"COMMIT|%H|%at|%H" --no-merges`,
      { timeout: 15_000, maxBuffer: 10 * 1024 * 1024 },
    ).toString();
  } catch (e) {
    console.warn(`[scout] git log (pre-check) failed: ${(e as Error).message}`);
    return [];
  }

  // Re-run with a simpler format to get message separately
  let logRaw: string;
  let filesRaw: string;
  try {
    logRaw = execSync(
      `git -C "${root}" log --since="${sinceStr}" --pretty=format:"%H|%at|%s" --no-merges`,
      { timeout: 15_000, maxBuffer: 5 * 1024 * 1024 },
    ).toString();
    filesRaw = execSync(
      `git -C "${root}" log --since="${sinceStr}" --name-only --pretty=format:"COMMIT:%H" --no-merges`,
      { timeout: 15_000, maxBuffer: 10 * 1024 * 1024 },
    ).toString();
  } catch (e) {
    console.warn(`[scout] git log failed: ${(e as Error).message}`);
    return [];
  }

  // Parse commit metadata
  const commitMap = new Map<string, CommitEntry>();
  for (const line of logRaw.split('\n')) {
    const parts = line.split('|');
    if (parts.length < 3) continue;
    const [hash, tsStr, ...msgParts] = parts;
    if (!hash || !tsStr) continue;
    const ts = parseInt(tsStr, 10) * 1000;
    const hour = new Date(ts).getHours();
    const message = msgParts.join('|');
    let score = scoreCommitMessage(message);
    if (isLateNight(hour)) score += 2;

    commitMap.set(hash, { hash, ts, hour, message, files: [], stressScore: score });
  }

  // Parse file lists
  let currentHash = '';
  for (const line of filesRaw.split('\n')) {
    if (line.startsWith('COMMIT:')) {
      currentHash = line.slice(7).trim();
    } else if (line.trim() && currentHash) {
      commitMap.get(currentHash)?.files.push(line.trim());
    }
  }

  return [...commitMap.values()];
}

/**
 * Cross-weight commit stress scores with file churn frequency to produce
 * Psychological Code Hotspot rankings.
 */
function computeHotspots(commits: CommitEntry[]): HotspotEntry[] {
  const fileData = new Map<string, { churn: number; stress: number; hashes: string[] }>();

  for (const c of commits) {
    for (const f of c.files) {
      const prev = fileData.get(f) ?? { churn: 0, stress: 0, hashes: [] };
      prev.churn += 1;
      prev.stress += c.stressScore;
      if (c.stressScore > 0) prev.hashes.push(c.hash.slice(0, 8));
      fileData.set(f, prev);
    }
  }

  const entries: HotspotEntry[] = [];
  for (const [file, data] of fileData) {
    const riskScore = data.churn * 1.0 + data.stress * 1.5;
    entries.push({
      file,
      churnCount: data.churn,
      stressScore: data.stress,
      riskScore: Math.round(riskScore * 10) / 10,
      topCommits: data.hashes.slice(0, 5),
    });
  }

  return entries.sort((a, b) => b.riskScore - a.riskScore).slice(0, 20);
}

// ── Ollama-assisted classification ────────────────────────────────────────────

/**
 * If Ollama is available, ask it to classify whether a commit message
 * indicates stress/rush. Returns null to fall back to regex scoring.
 */
async function ollamaClassifyCommit(
  message: string,
  ollama: OllamaCapability | null,
): Promise<number | null> {
  if (!ollama?.available) return null;
  const prompt =
    `Rate the developer stress level of this git commit message from 0 (calm) to 5 (high stress/rush). ` +
    `Respond with a single integer only.\nMessage: "${message}"`;
  const result = await ollamaInfer(prompt);
  if (!result) return null;
  const n = parseInt(result.trim(), 10);
  return isNaN(n) ? null : Math.min(5, Math.max(0, n));
}

// ── Main agent entry point ─────────────────────────────────────────────────────

export async function run(
  task: AgentTask,
  config: RunConfig,
  ollama: OllamaCapability | null,
): Promise<ScanResult> {
  if (task.type !== 'SCAN_AST') {
    throw new Error(`scout received unexpected task type: ${task.type}`);
  }

  const root = config.targetPath;
  const files = task.files;

  // ── 1. Stack detection ──────────────────────────────────────────────────────
  const stack = detectStack(root);
  console.log(`[scout] stack: ${stack}, files: ${files.length}`);

  // ── 2. AST parsing ──────────────────────────────────────────────────────────
  const tsFiles = files.filter((f) => /\.(ts|tsx|js|jsx)$/.test(f));
  const project = new Project({ skipAddingFilesFromTsConfig: true });

  for (const f of tsFiles) {
    try { project.addSourceFileAtPath(f); } catch { /* skip unparseable files */ }
  }

  let routes: Route[] = [];
  let forms: Form[] = [];

  if (stack === 'next.js') {
    routes = extractNextRoutes(tsFiles, root);
  }

  for (const sf of project.getSourceFiles()) {
    routes.push(...extractExpressRoutes(sf));
    try {
      const content = sf.getFullText();
      forms.push(...extractForms(content, sf.getFilePath()));
    } catch { /* skip */ }
  }

  // Also scan HTML/PHP/Python for forms
  for (const f of files) {
    if (/\.(html|php|py|erb|jinja)$/.test(f)) {
      try {
        const content = readFileSync(f, 'utf-8');
        forms.push(...extractForms(content, f));
      } catch { /* skip */ }
    }
  }

  // Deduplicate routes
  const seen = new Set<string>();
  routes = routes.filter((r) => {
    const key = `${r.method}:${r.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`[scout] routes: ${routes.length}, forms: ${forms.length}`);

  // ── 3. Impact graph ─────────────────────────────────────────────────────────
  const impactGraph = buildImpactGraph(tsFiles, root);

  // ── 4. Doc alignment ────────────────────────────────────────────────────────
  const docFeatures: DocFeature[] = [];
  const readmePath = join(root, 'README.md');
  if (existsSync(readmePath)) {
    const md = readFileSync(readmePath, 'utf-8');
    docFeatures.push(...parseMarkdownFeatures(md, readmePath));
  }
  const docsDir = join(root, 'docs');
  for (const { path, content } of readDocsDir(docsDir)) {
    docFeatures.push(...parseMarkdownFeatures(content, path));
  }

  const alignmentAlerts = crossCheck(docFeatures, routes);
  console.log(`[scout] doc features: ${docFeatures.length}, alignment alerts: ${alignmentAlerts.length}`);

  // ── 5. Git forensics (predictive mode) ──────────────────────────────────────
  let hotspots: HotspotEntry[] = [];

  if (config.predictive) {
    console.log('[scout] git forensics — 12-month analysis …');
    const commits = fetchGitLog(root);

    // Optionally refine stress scores with Ollama for top candidates
    if (ollama?.available) {
      const candidates = commits.filter((c) => c.stressScore === 0 && c.message.length > 10).slice(0, 50);
      for (const c of candidates) {
        const ollamaScore = await ollamaClassifyCommit(c.message, ollama);
        if (ollamaScore !== null && ollamaScore > 1) {
          c.stressScore = ollamaScore;
        }
      }
    }

    hotspots = computeHotspots(commits);
    console.log(`[scout] hotspots: ${hotspots.length} files ranked`);

    if (hotspots.length > 0) {
      console.log('[scout] top 5 hotspots:');
      hotspots.slice(0, 5).forEach((h, i) => {
        console.log(`  ${i + 1}. ${h.file} — risk: ${h.riskScore} (churn: ${h.churnCount}, stress: ${h.stressScore})`);
      });
    }
  }

  const result: ScanResult = {
    stack,
    routes,
    forms,
    docFeatures,
    alignmentAlerts,
    hotspots,
    impactGraph,
  };

  return result;
}
