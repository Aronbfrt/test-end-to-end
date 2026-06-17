/**
 * logDigest.ts — Crash log compressor.
 *
 * Reduces a raw test failure dump to the atomic triptyque the LLM needs:
 *   1. ASSERTION  — the broken expect / assertion line
 *   2. HTML       — the Byte-State compressed DOM snapshot at failure time
 *   3. CONSOLE    — filtered console output (errors + warnings only)
 *
 * Everything else is noise.  A typical Playwright failure report goes from
 * ~40 KB down to < 1 KB after digestion.
 */

import { compress, toPromptPayload } from './compressor.js';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface RawCrashLog {
  /** Full error message / stack from the test runner. */
  errorMessage: string;
  /** Raw HTML of the page at failure time (optional — from page.content()). */
  pageHtml?: string;
  /** Raw browser console log entries. */
  consoleLogs?: ConsoleEntry[];
  /** HTTP status code of the last navigation. */
  statusCode?: number;
  /** The route / URL that was being tested. */
  route?: string;
  /** Name of the failing test. */
  testName?: string;
}

export interface ConsoleEntry {
  type: 'log' | 'info' | 'warn' | 'error' | 'debug';
  text: string;
  url?: string;
  line?: number;
}

export interface DigestedLog {
  /** Broken assertion — single line, trimmed. */
  assertion: string;
  /** Byte-State compressed HTML payload (empty string when no HTML provided). */
  htmlPayload: string;
  /** Filtered console output — errors and warnings only, max 20 entries. */
  consoleOutput: string;
  /** Original route/URL. */
  route: string;
  /** HTTP status code. */
  statusCode: number;
  /** Test name. */
  testName: string;
  /** Compression stats for observability. */
  stats: {
    originalHtmlBytes: number;
    compressedHtmlBytes: number;
    reductionPct: number;
  };
}

// ── Assertion extraction ───────────────────────────────────────────────────────

/**
 * Pull the most informative assertion line from a raw error message.
 *
 * Priority order:
 *  1. Lines containing "Expected" / "Received" / "AssertionError"
 *  2. Lines containing "Error:" / "expect(" / "assert"
 *  3. First non-blank line
 */
function extractAssertion(raw: string): string {
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);

  const priority1 = lines.find((l) =>
    /expected|received|assertionerror|tobe|tohave|tocontain|toequal/i.test(l),
  );
  if (priority1) return priority1.slice(0, 280);

  const priority2 = lines.find((l) =>
    /error:|expect\(|assert|should\b/i.test(l),
  );
  if (priority2) return priority2.slice(0, 280);

  return (lines[0] ?? 'Unknown assertion failure').slice(0, 280);
}

// ── Console filtering ──────────────────────────────────────────────────────────

/**
 * Keep only error/warn entries.  Deduplicate and cap at 20 lines.
 * Format: [ERROR] text (url:line)
 */
function digestConsole(entries: ConsoleEntry[]): string {
  const interesting = entries.filter((e) => e.type === 'error' || e.type === 'warn');
  const deduped = [...new Map(interesting.map((e) => [e.text.slice(0, 120), e])).values()];
  const lines = deduped.slice(0, 20).map((e) => {
    const loc = e.url ? ` (${e.url}${e.line ? ':' + e.line : ''})` : '';
    return `[${e.type.toUpperCase()}] ${e.text.slice(0, 200)}${loc}`;
  });
  return lines.join('\n');
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Compress a raw crash log into the atomic triptyque.
 * This is the only function agents should call — everything else is internal.
 */
export function digest(raw: RawCrashLog): DigestedLog {
  const assertion = extractAssertion(raw.errorMessage);

  let htmlPayload = '';
  let stats = { originalHtmlBytes: 0, compressedHtmlBytes: 0, reductionPct: 0 };

  if (raw.pageHtml && raw.pageHtml.length > 0) {
    const graph = compress(raw.pageHtml);
    htmlPayload = toPromptPayload(graph);
    stats = {
      originalHtmlBytes: graph.stats.originalBytes,
      compressedHtmlBytes: graph.stats.compressedBytes,
      reductionPct: graph.stats.reductionPct,
    };
  }

  const consoleOutput = digestConsole(raw.consoleLogs ?? []);

  return {
    assertion,
    htmlPayload,
    consoleOutput,
    route:      raw.route     ?? 'unknown',
    statusCode: raw.statusCode ?? 0,
    testName:   raw.testName  ?? 'unknown',
    stats,
  };
}

/**
 * Format a DigestedLog as a compact LLM prompt block.
 * Callers inject this into Anthropic / Ollama messages.
 */
export function toPromptBlock(d: DigestedLog): string {
  return [
    `## Test failure: ${d.testName}`,
    `Route: ${d.route}  HTTP: ${d.statusCode}`,
    ``,
    `### ASSERTION`,
    d.assertion,
    ``,
    d.htmlPayload ? `### DOM (Byte-State)\n${d.htmlPayload.slice(0, 4000)}` : '',
    d.consoleOutput ? `### CONSOLE\n${d.consoleOutput}` : '',
  ].filter(Boolean).join('\n');
}
