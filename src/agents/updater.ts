/**
 * updater.ts — Intelligent test sync agent.
 *
 * Compares the current route map against the last persisted snapshot
 * (.e2e-work/last-routes.json) and generates tests only for new or
 * changed routes. Protects manually-written tests from being overwritten.
 *
 * Flags:
 *   dryRun — print what would change without writing any file
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AgentTask, RouteMap, RunConfig } from '../orchestrator.js';

interface OllamaCapability {
  available: boolean;
  model: string | null;
  endpoint: string;
}

interface RouteEntry {
  method: string;
  path: string;
  handler?: string;
}

interface FormEntry {
  action: string;
  method: string;
  fields: string[];
}

interface PersistedRouteMap {
  stack: string;
  routes: RouteEntry[];
  forms: FormEntry[];
  savedAt: string;
}

export interface UpdateResult {
  addedRoutes: string[];
  removedRoutes: string[];
  changedRoutes: string[];
  testsGenerated: number;
  dryRun: boolean;
}

function routeKey(r: RouteEntry): string {
  return `${r.method.toUpperCase()} ${r.path}`;
}

function routesEqual(a: RouteEntry, b: RouteEntry): boolean {
  return a.method.toLowerCase() === b.method.toLowerCase() && a.path === b.path && (a.handler ?? '') === (b.handler ?? '');
}

export async function run(
  task: AgentTask,
  config: RunConfig,
  ollama: OllamaCapability | null,
): Promise<UpdateResult> {
  if (task.type !== 'SCAN_AST') {
    throw new Error(`updater received unexpected task type: ${task.type}`);
  }

  const workDir = join(config.targetPath, '.e2e-work');
  if (!existsSync(workDir)) mkdirSync(workDir, { recursive: true });

  const snapshotPath = join(workDir, 'last-routes.json');
  const dryRun = (config as RunConfig & { dryRun?: boolean }).dryRun ?? false;

  // ── Get current route map via scout ────────────────────────────────────────
  const { run: scoutRun } = await import('./scout.js') as {
    run: (t: AgentTask, c: RunConfig, o: OllamaCapability | null) => Promise<RouteMap>;
  };
  const current = await scoutRun(task, config, ollama);

  // ── Load previous snapshot ─────────────────────────────────────────────────
  let previous: PersistedRouteMap | null = null;
  if (existsSync(snapshotPath)) {
    try {
      previous = JSON.parse(readFileSync(snapshotPath, 'utf-8')) as PersistedRouteMap;
    } catch {
      previous = null;
    }
  }

  if (!previous) {
    console.log('[updater] no previous snapshot — treating all routes as new');
    previous = { stack: '', routes: [], forms: [], savedAt: '' };
  }

  // ── Diff ───────────────────────────────────────────────────────────────────
  const prevKeys = new Map(previous.routes.map((r) => [routeKey(r), r]));
  const currKeys = new Map(current.routes.map((r) => [routeKey(r), r]));

  const addedRoutes: string[] = [];
  const removedRoutes: string[] = [];
  const changedRoutes: string[] = [];

  for (const [key, curr] of currKeys) {
    const prev = prevKeys.get(key);
    if (!prev) {
      addedRoutes.push(key);
    } else if (!routesEqual(curr, prev)) {
      changedRoutes.push(key);
    }
  }

  for (const key of prevKeys.keys()) {
    if (!currKeys.has(key)) removedRoutes.push(key);
  }

  // ── Report diff ────────────────────────────────────────────────────────────
  console.log(`[updater] diff: +${addedRoutes.length} added, ~${changedRoutes.length} changed, -${removedRoutes.length} removed`);

  if (addedRoutes.length > 0) {
    console.log('[updater] new routes:');
    addedRoutes.forEach((r) => console.log(`  +  ${r}`));
  }
  if (changedRoutes.length > 0) {
    console.log('[updater] changed routes:');
    changedRoutes.forEach((r) => console.log(`  ~  ${r}`));
  }
  if (removedRoutes.length > 0) {
    console.log('[updater] removed routes:');
    removedRoutes.forEach((r) => console.log(`  -  ${r}`));
  }

  if (addedRoutes.length === 0 && changedRoutes.length === 0) {
    console.log('[updater] ✓ tests already in sync — nothing to do');
    return { addedRoutes, removedRoutes, changedRoutes, testsGenerated: 0, dryRun };
  }

  if (dryRun) {
    console.log('[updater] --dry-run: no files written');
    return { addedRoutes, removedRoutes, changedRoutes, testsGenerated: 0, dryRun: true };
  }

  // ── Generate tests for new + changed routes only ───────────────────────────
  const targetPaths = new Set([...addedRoutes, ...changedRoutes]);
  const partialRouteMap: RouteMap = {
    stack: current.stack,
    routes: current.routes.filter((r) => targetPaths.has(routeKey(r))),
    forms: current.forms.filter((f) =>
      current.routes.some((r) => r.path === f.action && targetPaths.has(routeKey(r))),
    ),
  };

  const { run: artisanRun } = await import('./artisan.js') as {
    run: (t: AgentTask, c: RunConfig, o: OllamaCapability | null) => Promise<void>;
  };
  await artisanRun({ type: 'GEN_TESTS', routes: partialRouteMap }, config, ollama);

  const testsGenerated = targetPaths.size;
  console.log(`[updater] ✓ generated tests for ${testsGenerated} route(s)`);

  // ── Persist snapshot ───────────────────────────────────────────────────────
  const snapshot: PersistedRouteMap = {
    ...current,
    savedAt: new Date().toISOString(),
  };
  writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), 'utf-8');
  console.log(`[updater] snapshot saved → ${snapshotPath}`);

  return { addedRoutes, removedRoutes, changedRoutes, testsGenerated, dryRun: false };
}
