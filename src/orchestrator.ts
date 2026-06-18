/**
 * orchestrator.ts — Central cognitive brain.
 *
 * Responsibilities:
 *  1. Load the cache and skip unchanged files (Zero-Token Bypass).
 *  2. Detect Ollama on the host and route cheap string/AST tasks to it,
 *     reserving Anthropic tokens for semantic reasoning only.
 *  3. Maintain the global State Machine across a command run.
 *  4. Dispatch typed JSON payloads to sub-agents (scout, artisan, coroner,
 *     ghostwriter, evolver) through a strict contract so every agent is
 *     independently replaceable.
 */

import { execSync, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { writeCliReport } from './utils/report.js';
import {
  loadCache,
  isFresh,
  fingerprint,
  persistCache,
  snapshot,
} from './utils/cache.js';

// ── Types ──────────────────────────────────────────────────────────────────────

export type Level = 1 | 2 | 3;

export interface RunConfig {
  command: 'init' | 'audit' | 'shadow' | 'diff' | 'repair' | 'coverage' | 'update';
  level: Level;
  chaos: boolean;
  predictive: boolean;
  targetPath: string;
  /** repair --trace=<id>: load triage from .e2e-work/<traceId>.triage.json */
  traceId?: string;
  /** update --dry-run: show diff without writing files */
  dryRun?: boolean;
  /** coverage --detail: print per-route matched test files */
  detail?: boolean;
}

export type AgentTask =
  | { type: 'SCAN_AST';     files: string[] }
  | { type: 'GEN_TESTS';    routes: RouteMap; personas?: string[] }
  | { type: 'TRIAGE_CRASH'; traceId: string; screenshotPath?: string }
  | { type: 'WRITE_PATCH';  bugReport: BugReport }
  | { type: 'SELF_EVOLVE';  failedTask: AgentTask; reason: string };

export interface RouteMap {
  stack: string;
  routes: Array<{ method: string; path: string; handler?: string }>;
  forms: Array<{ action: string; method: string; fields: string[] }>;
}

export interface BugReport {
  route: string;
  statusCode: number;
  assertion: string;
  htmlSnippet: string;
  consoleOutput: string;
}

export type OrchestratorState =
  | 'IDLE'
  | 'SCANNING'
  | 'CACHE_CHECK'
  | 'DISPATCHING'
  | 'AWAITING_AGENTS'
  | 'RUNNING_TESTS'
  | 'TRIAGING'
  | 'PATCHING'
  | 'DONE'
  | 'ERROR';

interface OllamaCapability {
  available: boolean;
  model: string | null;
  endpoint: string;
}

// ── State ──────────────────────────────────────────────────────────────────────

let _state: OrchestratorState = 'IDLE';
let _config: RunConfig | null = null;
let _ollama: OllamaCapability | null = null;
let _lastHotspots: Array<{ file: string; risk: number; churn: number; stress: number }> = [];

// ── Internal helpers ───────────────────────────────────────────────────────────

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[orchestrator ${ts}] ${msg}`);
}

function setState(next: OrchestratorState): void {
  log(`state: ${_state} → ${next}`);
  _state = next;
}

// ── Ollama detection ───────────────────────────────────────────────────────────

/**
 * Probe the host for a running Ollama daemon.
 * Tries the default endpoint (127.0.0.1:11434) with a short timeout.
 * Falls back to the CLI binary if the HTTP probe fails.
 */
async function detectOllama(): Promise<OllamaCapability> {
  const endpoint = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434';

  // 1. HTTP probe — fastest path
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(`${endpoint}/api/tags`, { signal: controller.signal });
    clearTimeout(timer);

    if (res.ok) {
      const data = await res.json() as { models?: Array<{ name: string }> };
      const model = data.models?.[0]?.name ?? null;
      log(`Ollama detected via HTTP — model: ${model ?? 'none'} → Zero-Token Bypass ACTIVE`);
      return { available: true, model, endpoint };
    }
  } catch {
    // HTTP probe failed — try CLI
  }

  // 2. CLI fallback
  try {
    const out = execSync('ollama list --no-trunc 2>/dev/null', { timeout: 2000 }).toString();
    const firstLine = out.split('\n').find((l) => l.trim() && !l.startsWith('NAME'));
    const model = firstLine ? firstLine.split(/\s+/)[0] ?? null : null;
    if (model) {
      log(`Ollama detected via CLI — model: ${model} → Zero-Token Bypass ACTIVE`);
      return { available: true, model, endpoint };
    }
  } catch {
    // No Ollama
  }

  log('Ollama not detected — all inference routed to Anthropic');
  return { available: false, model: null, endpoint };
}

/**
 * Send a prompt to Ollama for cheap local inference (AST summarisation,
 * string classification, selector healing).
 * Returns null when Ollama is unavailable so callers can fall back to Anthropic.
 */
export async function ollamaInfer(prompt: string): Promise<string | null> {
  if (!_ollama?.available || !_ollama.model) return null;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    const res = await fetch(`${_ollama.endpoint}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: _ollama.model,
        prompt,
        stream: false,
        options: { temperature: 0.1 },  // low temp for deterministic AST work
      }),
    });
    clearTimeout(timer);

    if (!res.ok) return null;
    const data = await res.json() as { response?: string };
    return data.response ?? null;
  } catch {
    return null;
  }
}

// ── Cache-gated file processing ────────────────────────────────────────────────

/**
 * Given a list of file paths, return only those whose content has changed
 * since the last run. Also updates the cache with fresh fingerprints.
 *
 * Zero-Token Bypass: any file not returned here is skipped entirely —
 * no agent is invoked, no LLM token is spent.
 */
export function filterStale(files: string[]): string[] {
  const stale: string[] = [];
  for (const f of files) {
    if (!isFresh(f)) {
      fingerprint(f);
      stale.push(f);
    }
  }
  persistCache();
  log(`cache check: ${files.length} files → ${stale.length} stale (${files.length - stale.length} bypassed)`);
  return stale;
}

// ── Agent dispatch ─────────────────────────────────────────────────────────────

/**
 * Typed dispatch contract.
 * Agents are not imported here to keep the orchestrator decoupled — they are
 * dynamically imported so each can be replaced or upgraded independently.
 * Returns the agent's JSON response payload.
 */
export async function dispatch<T>(task: AgentTask): Promise<T> {
  const agentModule = agentForTask(task);
  log(`dispatch → ${agentModule} [${task.type}]`);

  // Dynamic import keeps the dependency graph clean.
  const mod = await import(`./agents/${agentModule}.js`) as { run: (t: AgentTask, cfg: RunConfig, ollama: OllamaCapability | null) => Promise<T> };
  return mod.run(task, _config!, _ollama);
}

function agentForTask(task: AgentTask): string {
  switch (task.type) {
    case 'SCAN_AST':     return _config?.command === 'coverage' ? 'coverage'
                              : _config?.command === 'update'   ? 'updater'
                              : 'scout';
    case 'GEN_TESTS':    return 'artisan';
    case 'TRIAGE_CRASH': return 'coroner';
    case 'WRITE_PATCH':  return 'ghostwriter';
    case 'SELF_EVOLVE':  return 'evolver';
  }
}

export function getLastHotspots(): typeof _lastHotspots {
  return _lastHotspots;
}

// ── State Machine ──────────────────────────────────────────────────────────────

/**
 * Run the full orchestration pipeline for a given command.
 * This is the single entry point called by src/index.ts.
 */
export async function run(config: RunConfig): Promise<void> {
  _config = config;

  try {
    // ── Phase 0: bootstrap ──────────────────────────────────────────────────
    setState('SCANNING');
    loadCache();
    _ollama = await detectOllama();

    // ── Phase 1: discover source files ─────────────────────────────────────
    const { glob } = await import('glob');
    const allFiles = await glob('**/*.{ts,js,py,php,rb,go}', {
      cwd: config.targetPath,
      ignore: ['node_modules/**', 'dist/**', '.git/**', '**/*.d.ts'],
      absolute: true,
    });

    // ── Phase 2: cache gate (bypassed for shadow — always full scan) ────────
    setState('CACHE_CHECK');
    const staleFiles = filterStale(allFiles);

    if (staleFiles.length === 0 && !['repair', 'shadow', 'coverage', 'update'].includes(config.command)) {
      log('All files fresh — Zero-Token Bypass: nothing to do');
      setState('DONE');
      return;
    }

    // ── Phase 3: dispatch ───────────────────────────────────────────────────
    setState('DISPATCHING');

    // diff: scope to git-changed files only
    let scanFiles = config.level === 1 ? staleFiles : allFiles;
    if (config.command === 'diff') {
      const diffFiles = getDiffFiles(config.targetPath);
      scanFiles = diffFiles.length > 0 ? diffFiles : staleFiles;
      log(`diff mode: scoping to ${scanFiles.length} changed files`);

      // predictive: overlay hotspot-ranked files from full history
      if (config.predictive) {
        const hotspotFiles = getHotspotFiles(config.targetPath, allFiles);
        const merged = [...new Set([...scanFiles, ...hotspotFiles])];
        log(`predictive: +${merged.length - scanFiles.length} hotspot files added`);
        scanFiles = merged;
      }
    }

    // coverage / update: dispatch to their own agents and skip the GEN_TESTS pipeline
    if (config.command === 'coverage' || config.command === 'update') {
      await dispatch<unknown>({ type: 'SCAN_AST', files: scanFiles });
      setState('DONE');
      return;
    }

    const rawScan = await dispatch<RouteMap & { hotspots?: Array<{ file: string; risk: number; churn: number; stress: number }> }>({
      type: 'SCAN_AST',
      files: scanFiles,
    });
    const scanResult: RouteMap = rawScan;
    _lastHotspots = rawScan.hotspots ?? [];

    setState('AWAITING_AGENTS');

    // shadow: always activate all 3 personas regardless of level
    const shadowPersonas: string[] | undefined =
      config.command === 'shadow' || config.level === 3
        ? ['frustrated_user', 'impulsive_buyer', 'malicious_attacker']
        : undefined;

    await dispatch<void>({
      type: 'GEN_TESTS',
      routes: scanResult,
      personas: shadowPersonas,
    });

    // ── Phase 3b: run tests + generate report ───────────────────────────────
    setState('RUNNING_TESTS');
    const cachedFiles = allFiles.length - staleFiles.length;
    const { runTests } = await import('./agents/runner.js');
    const testSummary = await runTests(config, cachedFiles);
    if (testSummary.runs.length > 0) {
      const reportPath = join(config.targetPath, 'tests', 'report.html');
      const ci = writeCliReport({ ...testSummary, hotspots: _lastHotspots }, reportPath);
      log(`report written → ${reportPath} (IC: ${ci}/100)`);
    }

    // ── Phase 4: triage (level 2+ on audit/diff/shadow) ─────────────────────
    let triageResult: import('./agents/coroner.js').TriageResult | null = null;
    if (config.level >= 2 && ['audit', 'diff', 'shadow'].includes(config.command)) {
      setState('TRIAGING');
      const traceId = `run-${Date.now()}`;
      const workDir = join(config.targetPath, '.e2e-work');
      if (!existsSync(workDir)) mkdirSync(workDir, { recursive: true });
      triageResult = await dispatch<import('./agents/coroner.js').TriageResult>({
        type: 'TRIAGE_CRASH',
        traceId,
      });
      log(`triage verdict: ${triageResult.verdict} (confidence: ${(triageResult.confidence * 100).toFixed(0)}%)`);
    }

    // ── Phase 5: auto-patch (level 3 / repair / shadow level 3) ─────────────
    if (config.command === 'repair' || config.level === 3) {
      setState('PATCHING');
      let bugReport = triageResult?.bugReport;

      // repair standalone: load triage from disk when no in-memory result
      if (!bugReport && config.command === 'repair') {
        const workDir = join(config.targetPath, '.e2e-work');
        try {
          if (config.traceId) {
            // explicit --trace=<id>
            const p = join(workDir, `${config.traceId}.triage.json`);
            if (existsSync(p)) {
              const saved = JSON.parse(readFileSync(p, 'utf-8')) as import('./agents/coroner.js').TriageResult;
              bugReport = saved.bugReport;
              log(`loaded triage from disk: ${config.traceId}`);
            } else {
              log(`triage file not found: ${p}`);
            }
          } else {
            // find latest .triage.json
            const { readdirSync } = await import('node:fs');
            const files = readdirSync(workDir)
              .filter((f) => f.endsWith('.triage.json'))
              .map((f) => ({ f, t: f.replace('.triage.json', '') }))
              .sort((a, b) => b.t.localeCompare(a.t));
            if (files.length > 0) {
              const latest = files[0];
              if (latest) {
                const p = join(workDir, latest.f);
                const saved = JSON.parse(readFileSync(p, 'utf-8')) as import('./agents/coroner.js').TriageResult;
                bugReport = saved.bugReport;
                log(`loaded latest triage from disk: ${latest.f}`);
              }
            }
          }
        } catch (e) {
          log(`could not load triage from disk: ${(e as Error).message}`);
        }
      }

      if (bugReport) {
        await dispatch<void>({ type: 'WRITE_PATCH', bugReport });
      } else {
        log('Ghostwriter on standby — no triage result available (run audit first, or use --trace=<id>)');
      }
    }

    setState('DONE');
    log(`Run complete [cmd=${config.command}] [level=${config.level}] [bypass=${allFiles.length - staleFiles.length} files]`);

  } catch (err) {
    setState('ERROR');
    console.error('[orchestrator] fatal:', err);

    // Self-evolve on unrecoverable errors (level 3 only — avoid infinite loops)
    if (_config?.level === 3 && _config.command !== 'repair') {
      try {
        log('Activating evolver for self-improvement …');
        await dispatch<void>({
          type: 'SELF_EVOLVE',
          failedTask: { type: 'SCAN_AST', files: [] },
          reason: (err as Error).message,
        });
      } catch { /* evolver failure is non-fatal */ }
    }
    throw err;
  } finally {
    persistCache();
  }
}

// ── Diff helpers ───────────────────────────────────────────────────────────────

function getDiffFiles(root: string): string[] {
  try {
    const out = execSync('git diff --name-only HEAD', {
      cwd: root, timeout: 5000, encoding: 'utf-8',
    });
    const staged = execSync('git diff --cached --name-only', {
      cwd: root, timeout: 5000, encoding: 'utf-8',
    });
    return [...new Set([...out.split('\n'), ...staged.split('\n')])]
      .filter((f) => f && /\.(ts|js|py|php|rb|go)$/.test(f))
      .map((f) => resolve(root, f))
      .filter(existsSync);
  } catch {
    return [];
  }
}

function getHotspotFiles(root: string, allFiles: string[]): string[] {
  try {
    const out = execSync(
      `git -C "${root}" log --since="12 months ago" --name-only --pretty=format:"" --no-merges`,
      { timeout: 8000, encoding: 'utf-8', maxBuffer: 5 * 1024 * 1024 },
    );
    const churn = new Map<string, number>();
    for (const line of out.split('\n').filter(Boolean)) {
      const abs = resolve(root, line);
      if (allFiles.includes(abs)) churn.set(abs, (churn.get(abs) ?? 0) + 1);
    }
    return [...churn.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([f]) => f);
  } catch {
    return [];
  }
}

/**
 * Expose orchestrator diagnostics (used by the MCP tool + Express dashboard).
 */
export function diagnostics() {
  return {
    state: _state,
    config: _config,
    ollama: _ollama,
    cache: snapshot(),
  };
}
