/**
 * cache.ts — Atomic file-hash registry.
 *
 * Reads and writes .e2e-cache.json with SHA-256 fingerprints of every source
 * file the orchestrator has already analysed. When a fingerprint is unchanged
 * the orchestrator skips the LLM call entirely (Zero-Token Bypass).
 *
 * Design constraints:
 *  - All I/O is synchronous so the orchestrator's hot path stays sequential.
 *  - Writes are atomic: we write to a .tmp sibling then rename, so a crash
 *    mid-write never corrupts the cache on disk.
 *  - The module is a pure singleton — one in-memory snapshot for the whole
 *    process lifetime.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface CacheEntry {
  sha256: string;
  md5: string;
  /** Unix timestamp (ms) of the last observed modification. */
  ts: number;
}

export interface CacheFile {
  version: number;
  /** Map from absolute file path → fingerprint data. */
  hashes: Record<string, CacheEntry>;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const CACHE_VERSION = 1;

let _cachePath = resolve(process.cwd(), '.e2e-cache.json');

/** Must be called before loadCache() — sets cache to the target project directory. */
export function initCachePath(targetPath: string): void {
  const workDir = join(targetPath, '.e2e-work');
  if (!existsSync(workDir)) mkdirSync(workDir, { recursive: true });
  _cachePath = join(workDir, '.e2e-cache.json');
}

// ── In-memory state ────────────────────────────────────────────────────────────

let _cache: CacheFile = { version: CACHE_VERSION, hashes: {} };
let _dirty = false;

// ── Initialisation ─────────────────────────────────────────────────────────────

/**
 * Load the cache from disk into memory.
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export function loadCache(): void {
  if (!existsSync(_cachePath)) {
    _cache = { version: CACHE_VERSION, hashes: {} };
    return;
  }
  try {
    const raw = readFileSync(_cachePath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'version' in parsed &&
      'hashes' in parsed
    ) {
      _cache = parsed as CacheFile;
    } else {
      _cache = { version: CACHE_VERSION, hashes: {} };
    }
  } catch {
    // Corrupted JSON — start fresh.
    _cache = { version: CACHE_VERSION, hashes: {} };
  }
}

// ── Core API ───────────────────────────────────────────────────────────────────

/**
 * Compute the SHA-256 and MD5 digests of a buffer.
 */
function digest(buf: Buffer): { sha256: string; md5: string } {
  return {
    sha256: createHash('sha256').update(buf).digest('hex'),
    md5: createHash('md5').update(buf).digest('hex'),
  };
}

/**
 * Returns true when the file on disk matches the cached fingerprint.
 * Also returns true when the file doesn't exist (nothing to re-analyse).
 * Returns false when the file is new or has changed — the caller must reprocess it.
 */
export function isFresh(filePath: string): boolean {
  const abs = resolve(filePath);
  if (!existsSync(abs)) return true;

  const entry = _cache.hashes[abs];
  if (!entry) return false;

  let buf: Buffer;
  try {
    buf = readFileSync(abs);
  } catch {
    return false;
  }

  const { sha256 } = digest(buf);
  return sha256 === entry.sha256;
}

/**
 * Compute and store the fingerprint for a file.
 * Returns the new CacheEntry so callers can log it.
 */
export function fingerprint(filePath: string): CacheEntry | null {
  const abs = resolve(filePath);
  if (!existsSync(abs)) return null;

  let buf: Buffer;
  try {
    buf = readFileSync(abs);
  } catch {
    return null;
  }

  const { sha256, md5 } = digest(buf);
  const entry: CacheEntry = { sha256, md5, ts: Date.now() };
  _cache.hashes[abs] = entry;
  _dirty = true;
  return entry;
}

/**
 * Retrieve the stored entry for a file path (or undefined if uncached).
 */
export function getEntry(filePath: string): CacheEntry | undefined {
  return _cache.hashes[resolve(filePath)];
}

/**
 * Delete the entry for a path (e.g. when a file is removed from the project).
 */
export function invalidate(filePath: string): void {
  const abs = resolve(filePath);
  if (_cache.hashes[abs]) {
    delete _cache.hashes[abs];
    _dirty = true;
  }
}

/**
 * Persist the in-memory cache to disk atomically.
 * Uses a .tmp sibling + rename — crash-safe.
 * No-op when nothing changed since the last persist.
 */
export function persistCache(): void {
  if (!_dirty) return;

  const tmp = _cachePath + '.tmp';
  try {
    writeFileSync(tmp, JSON.stringify(_cache, null, 2), 'utf-8');
    renameSync(tmp, _cachePath);
    _dirty = false;
  } catch (err) {
    // Non-fatal — worst case the cache is stale on the next run.
    console.warn('[cache] persist failed:', (err as Error).message);
  }
}

/**
 * Return the full in-memory snapshot (read-only view for diagnostics).
 */
export function snapshot(): Readonly<CacheFile> {
  return _cache;
}

/**
 * Wipe all entries. Used by tests and the `--reset-cache` CLI flag.
 */
export function clearCache(): void {
  _cache = { version: CACHE_VERSION, hashes: {} };
  _dirty = true;
}
