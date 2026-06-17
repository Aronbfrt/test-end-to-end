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
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
  command: 'init' | 'audit' | 'shadow' | 'diff' | 'repair';
  level: Level;
  chaos: boolean;
  predictive: boolean;
  targetPath: string;
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
    case 'SCAN_AST':     return 'scout';
    case 'GEN_TESTS':    return 'artisan';
    case 'TRIAGE_CRASH': return 'coroner';
    case 'WRITE_PATCH':  return 'ghostwriter';
    case 'SELF_EVOLVE':  return 'evolver';
  }
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

    // ── Phase 2: cache gate ─────────────────────────────────────────────────
    setState('CACHE_CHECK');
    const staleFiles = filterStale(allFiles);

    if (staleFiles.length === 0 && config.command !== 'repair') {
      log('All files fresh — Zero-Token Bypass: nothing to do');
      setState('DONE');
      return;
    }

    // ── Phase 3: dispatch ───────────────────────────────────────────────────
    setState('DISPATCHING');

    const scanResult = await dispatch<RouteMap>({
      type: 'SCAN_AST',
      files: config.level === 1 ? staleFiles : allFiles,
    });

    setState('AWAITING_AGENTS');

    await dispatch<void>({
      type: 'GEN_TESTS',
      routes: scanResult,
      personas: config.level === 3
        ? ['frustrated_user', 'impulsive_buyer', 'malicious_attacker']
        : undefined,
    });

    // ── Phase 4: triage (level 2+) ──────────────────────────────────────────
    if (config.level >= 2 && config.command === 'audit') {
      setState('TRIAGING');
      // Coroner reads the test runner output from the shared work dir.
      await dispatch<void>({
        type: 'TRIAGE_CRASH',
        traceId: `run-${Date.now()}`,
      });
    }

    // ── Phase 5: auto-patch (level 3 / repair command) ──────────────────────
    if (config.command === 'repair' || config.level === 3) {
      setState('PATCHING');
      // Ghostwriter is invoked by coroner's output — placeholder JSON here.
      log('Ghostwriter on standby — awaiting coroner bug report');
    }

    setState('DONE');
    log(`Run complete [level=${config.level}] [bypass=${allFiles.length - staleFiles.length} files]`);

  } catch (err) {
    setState('ERROR');
    console.error('[orchestrator] fatal:', err);
    throw err;
  } finally {
    persistCache();
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
