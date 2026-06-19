/**
 * metricsTracker.ts — Couche persistance SQLite (FinOps, Green-IT, historique).
 *
 * Base : .e2e-work/storage.sqlite
 * Tables :
 *   runs      — historique des audits (IC, passed/failed, durée)
 *   triages   — résultats Coroner (verdict, confidence, route)
 *   patches   — correctifs Ghostwriter (fichiers patchés, traceId)
 *   metrics   — métriques globales (tokens économisés, CO₂, RGPD)
 *
 * CO₂ estimation :
 *   1 token GPT-4 ≈ 0.002g CO₂ (source: Patterson et al. 2021, ajusté)
 *   Ollama local ≈ 0.00002g CO₂/token (CPU local, facteur ×100 moins)
 *   Gain = tokens_saved × (0.002 - 0.00002) = tokens_saved × 0.00198 g
 *
 * FinOps :
 *   GPT-4o input ≈ $0.000005/token (mai 2025)
 *   Économie = tokens_saved × $0.000005
 */

import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

type DB = InstanceType<typeof Database>;

const _dir    = dirname(fileURLToPath(import.meta.url));
const DB_PATH = resolve(_dir, '../../.e2e-work/storage.sqlite');
const DB_DIR  = dirname(DB_PATH);

// ── Lazy SQLite init ──────────────────────────────────────────────────────────

let _db: DB | null = null;

function getDb(): DB | null {
  if (_db) return _db;
  try {
    if (!existsSync(DB_DIR)) mkdirSync(DB_DIR, { recursive: true });
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.pragma('synchronous = NORMAL');
    initSchema(_db);
    return _db;
  } catch (e) {
    console.warn(`[metricsTracker] SQLite non disponible: ${(e as Error).message}`);
    return null;
  }
}

function initSchema(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      ts           TEXT    NOT NULL DEFAULT (datetime('now')),
      command      TEXT    NOT NULL,
      level        INTEGER NOT NULL,
      target       TEXT    NOT NULL,
      passed       INTEGER NOT NULL DEFAULT 0,
      failed       INTEGER NOT NULL DEFAULT 0,
      cached       INTEGER NOT NULL DEFAULT 0,
      ci_score     INTEGER NOT NULL DEFAULT 0,
      duration_ms  INTEGER NOT NULL DEFAULT 0,
      tokens_saved INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS triages (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ts         TEXT    NOT NULL DEFAULT (datetime('now')),
      trace_id   TEXT    NOT NULL,
      verdict    TEXT    NOT NULL,
      confidence REAL    NOT NULL DEFAULT 0,
      route      TEXT    NOT NULL,
      target     TEXT    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS patches (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      ts            TEXT    NOT NULL DEFAULT (datetime('now')),
      trace_id      TEXT    NOT NULL,
      route         TEXT    NOT NULL,
      files_patched INTEGER NOT NULL DEFAULT 0,
      target        TEXT    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS metrics (
      id    INTEGER PRIMARY KEY AUTOINCREMENT,
      ts    TEXT    NOT NULL DEFAULT (datetime('now')),
      key   TEXT    NOT NULL,
      value REAL    NOT NULL,
      target TEXT   NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      last_used INTEGER NOT NULL,
      run_count INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS active_runs (
      run_id TEXT PRIMARY KEY,
      pid INTEGER,
      command TEXT NOT NULL,
      target_path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      exit_code INTEGER
    );
  `);
}

// ── Types ──────────────────────────────────────────────────────────────────────

export interface RunRecord {
  command:     string;
  level:       number;
  target:      string;
  passed:      number;
  failed:      number;
  cached:      number;
  ciScore:     number;
  durationMs:  number;
  tokensSaved: number;
}

export interface TriageRecord {
  traceId:    string;
  verdict:    string;
  confidence: number;
  route:      string;
  target:     string;
}

export interface PatchRecord {
  traceId:      string;
  route:        string;
  filesPatched: number;
  target:       string;
}

export interface GlobalStats {
  totalRuns:      number;
  totalTriages:   number;
  totalPatches:   number;
  tokensSaved:    number;
  co2SavedMg:     number;
  finOpsSavedUsd: number;
  rgpdMasked:     number;
}

// ── CO₂ / FinOps helpers ──────────────────────────────────────────────────────

const CO2_G_PER_TOKEN_CLOUD  = 0.002;    // g CO₂ per token (cloud LLM)
const CO2_G_PER_TOKEN_LOCAL  = 0.00002;  // g CO₂ per token (Ollama local)
const COST_USD_PER_TOKEN     = 0.000005; // $/token (GPT-4o input, mai 2025)

export function computeCo2Saved(tokensSaved: number): number {
  return tokensSaved * (CO2_G_PER_TOKEN_CLOUD - CO2_G_PER_TOKEN_LOCAL) * 1000; // mg
}

export function computeFinOpsSaved(tokensSaved: number): number {
  return tokensSaved * COST_USD_PER_TOKEN;
}

// ── Public API ─────────────────────────────────────────────────────────────────

export async function recordRun(r: RunRecord): Promise<void> {
  const db = getDb();
  if (!db) return;
  try {
    db.prepare(`
      INSERT INTO runs (command, level, target, passed, failed, cached, ci_score, duration_ms, tokens_saved)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(r.command, r.level, r.target, r.passed, r.failed, r.cached, r.ciScore, r.durationMs, r.tokensSaved);
  } catch (e) {
    console.warn(`[metricsTracker] recordRun: ${(e as Error).message}`);
  }
}

export async function recordTriage(r: TriageRecord): Promise<void> {
  const db = getDb();
  if (!db) return;
  try {
    db.prepare(`
      INSERT INTO triages (trace_id, verdict, confidence, route, target)
      VALUES (?, ?, ?, ?, ?)
    `).run(r.traceId, r.verdict, r.confidence, r.route, r.target);
  } catch (e) {
    console.warn(`[metricsTracker] recordTriage: ${(e as Error).message}`);
  }
}

export async function recordPatch(r: PatchRecord): Promise<void> {
  const db = getDb();
  if (!db) return;
  try {
    db.prepare(`
      INSERT INTO patches (trace_id, route, files_patched, target)
      VALUES (?, ?, ?, ?)
    `).run(r.traceId, r.route, r.filesPatched, r.target);
  } catch (e) {
    console.warn(`[metricsTracker] recordPatch: ${(e as Error).message}`);
  }
}

export async function recordMetric(key: string, value: number, target = ''): Promise<void> {
  const db = getDb();
  if (!db) return;
  try {
    db.prepare('INSERT INTO metrics (key, value, target) VALUES (?, ?, ?)').run(key, value, target);
  } catch (e) {
    console.warn(`[metricsTracker] recordMetric: ${(e as Error).message}`);
  }
}

export function getStats(target?: string): GlobalStats {
  const db = getDb();
  if (!db) {
    return { totalRuns: 0, totalTriages: 0, totalPatches: 0, tokensSaved: 0, co2SavedMg: 0, finOpsSavedUsd: 0, rgpdMasked: 0 };
  }

  try {
    const whereRuns    = target ? 'WHERE target = ?' : '';
    const args         = target ? [target] : [];

    const runs    = db.prepare(`SELECT COUNT(*) as n, COALESCE(SUM(tokens_saved),0) as t FROM runs ${whereRuns}`).get(...args) as { n: number; t: number };
    const triages = db.prepare(`SELECT COUNT(*) as n FROM triages ${whereRuns}`).get(...args) as { n: number };
    const patches = db.prepare(`SELECT COUNT(*) as n FROM patches ${whereRuns}`).get(...args) as { n: number };
    const rgpd    = db.prepare(`SELECT COALESCE(SUM(value),0) as n FROM metrics WHERE key='rgpd_masked' ${target ? 'AND target=?' : ''}`).get(...args) as { n: number };

    const tokensSaved = runs.t;
    return {
      totalRuns:      runs.n,
      totalTriages:   triages.n,
      totalPatches:   patches.n,
      tokensSaved,
      co2SavedMg:     computeCo2Saved(tokensSaved),
      finOpsSavedUsd: computeFinOpsSaved(tokensSaved),
      rgpdMasked:     rgpd.n,
    };
  } catch (e) {
    console.warn(`[metricsTracker] getStats: ${(e as Error).message}`);
    return { totalRuns: 0, totalTriages: 0, totalPatches: 0, tokensSaved: 0, co2SavedMg: 0, finOpsSavedUsd: 0, rgpdMasked: 0 };
  }
}

export function getRecentRuns(limit = 20, target?: string): unknown[] {
  const db = getDb();
  if (!db) return [];
  try {
    const where = target ? 'WHERE target = ?' : '';
    const args  = target ? [target, limit] : [limit];
    return db.prepare(`SELECT * FROM runs ${where} ORDER BY ts DESC LIMIT ?`).all(...args);
  } catch {
    return [];
  }
}

export function getRecentTriages(limit = 20, target?: string): unknown[] {
  const db = getDb();
  if (!db) return [];
  try {
    const where = target ? 'WHERE target = ?' : '';
    const args  = target ? [target, limit] : [limit];
    return db.prepare(`SELECT * FROM triages ${where} ORDER BY ts DESC LIMIT ?`).all(...args);
  } catch {
    return [];
  }
}

export function upsertProject(path: string): void {
  const db = getDb();
  if (!db) return;
  try {
    const name = path.split('/').filter(Boolean).pop() ?? path;
    db.prepare(`
      INSERT INTO projects (path, name, last_used, run_count) VALUES (?, ?, ?, 1)
      ON CONFLICT(path) DO UPDATE SET last_used = excluded.last_used, run_count = run_count + 1
    `).run(path, name, Date.now());
  } catch (e) {
    console.warn(`[metricsTracker] upsertProject: ${(e as Error).message}`);
  }
}

export function listRecentProjects(limit = 10): Array<{ id: number; path: string; name: string; last_used: number; run_count: number }> {
  const db = getDb();
  if (!db) return [];
  try {
    return db.prepare('SELECT * FROM projects ORDER BY last_used DESC LIMIT ?').all(limit) as Array<{ id: number; path: string; name: string; last_used: number; run_count: number }>;
  } catch { return []; }
}

export function insertActiveRun(runId: string, pid: number, command: string, targetPath: string): void {
  const db = getDb();
  if (!db) return;
  try {
    db.prepare('INSERT OR REPLACE INTO active_runs (run_id, pid, command, target_path, status, started_at) VALUES (?, ?, ?, ?, ?, ?)').run(runId, pid, command, targetPath, 'running', Date.now());
  } catch (e) {
    console.warn(`[metricsTracker] insertActiveRun: ${(e as Error).message}`);
  }
}

export function updateActiveRun(runId: string, status: 'done' | 'error' | 'stopped', exitCode: number): void {
  const db = getDb();
  if (!db) return;
  try {
    db.prepare('UPDATE active_runs SET status = ?, ended_at = ?, exit_code = ? WHERE run_id = ?').run(status, Date.now(), exitCode, runId);
  } catch (e) {
    console.warn(`[metricsTracker] updateActiveRun: ${(e as Error).message}`);
  }
}

export function listActiveRuns(): Array<{ run_id: string; pid: number; command: string; target_path: string; status: string; started_at: number }> {
  const db = getDb();
  if (!db) return [];
  try {
    return db.prepare('SELECT * FROM active_runs ORDER BY started_at DESC').all() as Array<{ run_id: string; pid: number; command: string; target_path: string; status: string; started_at: number }>;
  } catch { return []; }
}

export function cleanStaleRuns(): void {
  const db = getDb();
  if (!db) return;
  try {
    const staleThreshold = Date.now() - 3600000;
    db.prepare("UPDATE active_runs SET status='error' WHERE status='running' AND started_at < ?").run(staleThreshold);
  } catch (e) {
    console.warn(`[metricsTracker] cleanStaleRuns: ${(e as Error).message}`);
  }
}
