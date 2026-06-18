/**
 * runner.ts — Playwright test executor.
 *
 * Runs `npx playwright test --reporter=json` in the target project directory,
 * parses the JSON output, and:
 *  1. Returns a RunSummary for report generation.
 *  2. Writes CrashContext JSON files for each failure so the Coroner can triage.
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunConfig } from '../orchestrator.js';
import type { RunSummary, TestRun } from '../utils/report.js';
import { sanitizeObject } from './rgpdGuard.js';

// Use the plugin's own playwright binary so target projects don't need
// @playwright/test installed, and there's never a version conflict.
const _pluginRoot        = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const _pluginNodeModules = join(_pluginRoot, 'node_modules');
const _playwrightBin     = join(_pluginNodeModules, '.bin', 'playwright');

// ── Playwright JSON report types ───────────────────────────────────────────────

interface PWResult {
  suites?: PWSuite[];
  stats?: { expected?: number; unexpected?: number; skipped?: number; duration?: number };
}

interface PWSuite {
  file?: string;
  title?: string;
  suites?: PWSuite[];
  specs?: PWSpec[];
}

interface PWSpec {
  title: string;
  ok: boolean;
  file?: string;
  tests?: Array<{
    results?: Array<{
      status?: string;
      duration?: number;
      error?: { message?: string; value?: string } | null;
    }>;
  }>;
}

function flattenSpecs(suite: PWSuite, inheritedFile?: string): PWSpec[] {
  const file = suite.file ?? inheritedFile;
  const own  = (suite.specs ?? []).map((s) => ({ ...s, file: s.file ?? file }));
  const sub  = (suite.suites ?? []).flatMap((s) => flattenSpecs(s, file));
  return [...own, ...sub];
}

function extractSelector(error: string): string | undefined {
  const m = error.match(/locator\(['"`]([^'"`]+)['"`]\)/);
  return m?.[1];
}

function routeFromFile(filePath: string, targetPath: string): string {
  const rel = filePath.replace(/\\/g, '/').replace(targetPath.replace(/\\/g, '/'), '');
  const parts = rel.split('/').filter(Boolean);
  const testIdx = parts.indexOf('tests');
  const after = testIdx >= 0 ? parts.slice(testIdx + 1) : parts;
  const clean = after
    .filter((p) => p && !p.endsWith('.spec.ts') && !p.endsWith('.test.ts'))
    .map((p) => p.replace(/\.spec\.(ts|js)$/, '').replace(/\.test\.(ts|js)$/, ''));
  return '/' + clean.join('/');
}

// ── Main runner ────────────────────────────────────────────────────────────────

export async function runTests(config: RunConfig, cachedFiles: number): Promise<RunSummary> {
  const workDir = join(config.targetPath, '.e2e-work');
  if (!existsSync(workDir)) mkdirSync(workDir, { recursive: true });

  const runs: TestRun[] = [];
  let rawOutput = '';

  try {
    rawOutput = execSync(`"${_playwrightBin}" test --reporter=json`, {
      cwd:       config.targetPath,
      timeout:   120_000,
      encoding:  'utf-8',
      stdio:     ['ignore', 'pipe', 'ignore'],
      maxBuffer: 20 * 1024 * 1024,
      env:       {
        ...process.env,
        CI: '1',
        FORCE_COLOR: '0',
        // Make @playwright/test resolvable from the plugin's node_modules
        NODE_PATH: process.env['NODE_PATH']
          ? `${_pluginNodeModules}:${process.env['NODE_PATH']}`
          : _pluginNodeModules,
      },
    });
  } catch (e: unknown) {
    const err = e as { stdout?: string; message?: string };
    rawOutput = err.stdout ?? '';
    if (!rawOutput) {
      const msg = err.message ?? String(e);
      const label = msg.includes('ETIMEDOUT') ? 'playwright test run timed out (> 5 min)' : `playwright unavailable: ${msg}`;
      console.log(`[runner] ${label}`);
      return { runs, tokensUsed: 0, tokensSaved: 0, cachedFiles };
    }
  }

  let pw: PWResult;
  try {
    pw = JSON.parse(rawOutput) as PWResult;
  } catch {
    console.log('[runner] could not parse playwright JSON output');
    return { runs, tokensUsed: 0, tokensSaved: 0, cachedFiles };
  }

  const specs = (pw.suites ?? []).flatMap((s) => flattenSpecs(s));

  for (const spec of specs) {
    const result = spec.tests?.[0]?.results?.[0];
    if (!result) continue;

    const route   = routeFromFile(spec.file ?? '', config.targetPath);
    const verdict: TestRun['verdict'] =
      result.status === 'passed' ? 'PASS' :
      result.status === 'skipped' ? 'SKIP' : 'FAIL';

    const traceId = verdict === 'FAIL'
      ? `run-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
      : undefined;

    runs.push({
      id:          `${spec.file ?? ''}::${spec.title}`,
      route,
      testName:    spec.title,
      verdict,
      durationMs:  result.duration ?? 0,
      traceId,
    });

    if (verdict === 'FAIL' && traceId) {
      const errorMsg = result.error?.message ?? result.error?.value ?? 'Test failure';
      const raw = {
        traceId,
        testName:       spec.title,
        route,
        statusCode:     /404/i.test(errorMsg) ? 404 : /500/i.test(errorMsg) ? 500 : 0,
        errorMessage:   errorMsg.slice(0, 2000),
        pageHtml:       '',
        consoleLogs:    [] as string[],
        brokenSelector: extractSelector(errorMsg),
      };
      const { sanitized } = sanitizeObject(raw);
      const crashPath = join(workDir, `${traceId}.json`);
      writeFileSync(crashPath, JSON.stringify(sanitized, null, 2), 'utf-8');
    }
  }

  const passed = runs.filter((r) => r.verdict === 'PASS').length;
  console.log(`[runner] ${passed}/${runs.length} tests passed`);

  return { runs, tokensUsed: 0, tokensSaved: 0, cachedFiles };
}
