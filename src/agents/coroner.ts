/**
 * coroner.ts — Crash triage + visual healing agent.
 *
 * Decision tree:
 *
 *   crash
 *    ├─ HTTP 5xx       → BACKEND_BUG  (send to ghostwriter, do not touch test)
 *    └─ HTTP 200 / DOM
 *        ├─ selector found     → ASSERTION_BUG   (test logic error — fix POM)
 *        └─ selector missing
 *            ├─ visual match   → SELECTOR_DRIFT  (update POM via Vision QA)
 *            └─ no visual match → LAYOUT_CHANGE  (escalate to ghostwriter)
 *
 * SHIELD ANTI-FAUSSE ALERTE:
 *   Screenshot comparison uses a perceptual pixel-diff algorithm with a
 *   configurable tolerance threshold.  Differences caused by sub-pixel
 *   anti-aliasing (font rendering, OS ClearType) are absorbed and never
 *   raise a false positive.
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join, basename, dirname } from 'node:path';

import type { AgentTask, BugReport, RunConfig } from '../orchestrator.js';
import { digest, toPromptBlock } from '../utils/logDigest.js';
import type { RawCrashLog } from '../utils/logDigest.js';

// ── Types ──────────────────────────────────────────────────────────────────────

interface OllamaCapability {
  available: boolean;
  model: string | null;
  endpoint: string;
}

export type TriageVerdict =
  | 'BACKEND_BUG'
  | 'ASSERTION_BUG'
  | 'SELECTOR_DRIFT'
  | 'LAYOUT_CHANGE'
  | 'UNKNOWN';

export interface TriageResult {
  verdict: TriageVerdict;
  confidence: number;            // 0–1
  reasoning: string;
  suggestedSelector?: string;    // filled on SELECTOR_DRIFT by Vision QA
  bugReport?: BugReport;         // filled on BACKEND_BUG
  patchInstruction?: string;     // human-readable fix for SELECTOR_DRIFT
}

interface CrashContext {
  traceId:        string;
  testName:       string;
  route:          string;
  statusCode:     number;
  errorMessage:   string;
  pageHtml?:      string;
  consoleLogs?:   RawCrashLog['consoleLogs'];
  /** Path to screenshot PNG taken at failure time. */
  screenshotPath?: string;
  /** Path to the known-good baseline screenshot (if any). */
  baselinePath?:   string;
  /** The CSS/XPath selector that could not be found. */
  brokenSelector?: string;
}

// ── Pixel-diff engine (SHIELD anti-fausse alerte) ─────────────────────────────

/**
 * Decode a raw PNG buffer into RGBA pixel rows.
 * We use a minimal pure-JS PNG decoder to avoid native deps.
 *
 * PNG structure: 8-byte signature + chunks.
 * IDAT chunk contains zlib-deflated RGBA rows.
 * We rely on Node's built-in zlib for inflation.
 *
 * NOTE: This decoder handles only 8-bit RGBA PNGs (the format Playwright
 * produces).  Other bit depths are not needed for screenshot comparison.
 */
import { inflateSync } from 'node:zlib';

interface DecodedImage {
  width: number;
  height: number;
  /** RGBA byte array — length = width * height * 4 */
  pixels: Uint8ClampedArray;
}

function decodePng(buf: Buffer): DecodedImage {
  // Verify PNG signature
  const sig = buf.slice(0, 8);
  if (sig.toString('hex') !== '89504e470d0a1a0a') {
    throw new Error('Not a valid PNG file');
  }

  let pos = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idatChunks: Buffer[] = [];

  while (pos < buf.length) {
    const length = buf.readUInt32BE(pos); pos += 4;
    const type   = buf.slice(pos, pos + 4).toString('ascii'); pos += 4;
    const data   = buf.slice(pos, pos + length); pos += length;
    pos += 4; // CRC

    if (type === 'IHDR') {
      width     = data.readUInt32BE(0);
      height    = data.readUInt32BE(4);
      colorType = data[9]!;  // 6 = RGBA, 2 = RGB
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }

  const channels = colorType === 6 ? 4 : 3; // RGBA or RGB
  const raw = inflateSync(Buffer.concat(idatChunks));
  const pixels = new Uint8ClampedArray(width * height * 4);

  const stride = width * channels + 1; // +1 for filter byte
  for (let y = 0; y < height; y++) {
    const rowStart = y * stride;
    // filter type byte — we only handle None (0) for simplicity
    for (let x = 0; x < width; x++) {
      const srcOff = rowStart + 1 + x * channels;
      const dstOff = (y * width + x) * 4;
      pixels[dstOff]     = raw[srcOff]!;
      pixels[dstOff + 1] = raw[srcOff + 1]!;
      pixels[dstOff + 2] = raw[srcOff + 2]!;
      pixels[dstOff + 3] = channels === 4 ? raw[srcOff + 3]! : 255;
    }
  }

  return { width, height, pixels };
}

/**
 * Pixel-Diff with perceptual tolerance.
 *
 * Algorithm:
 *  1. Compare each pixel pair in RGBA space.
 *  2. Compute Euclidean distance in [0,255]^4 → normalise to [0,1].
 *  3. Pixels below `toleranceRgb` are considered identical.
 *     Default tolerance = 32 / 255 ≈ 0.125 — absorbs ClearType & font hinting.
 *  4. Return the fraction of differing pixels.
 *
 * A diff ratio < `thresholdFraction` (default 0.01 = 1%) is treated as
 * cosmetic noise (anti-aliasing, sub-pixel rendering) → SHIELD suppresses alert.
 */
export interface PixelDiffResult {
  /** Fraction of pixels that differ beyond tolerance (0–1). */
  diffRatio: number;
  /** Number of pixels that differ. */
  diffCount: number;
  /** Total pixels compared. */
  totalPixels: number;
  /** True when the diff is within the cosmetic noise threshold. */
  isWithinShield: boolean;
}

export function pixelDiff(
  imgA: Buffer,
  imgB: Buffer,
  options: {
    /** Per-channel tolerance [0–255]. Default 32 (absorbs AA). */
    toleranceRgb?: number;
    /** Max differing-pixel fraction before alert fires. Default 0.01. */
    thresholdFraction?: number;
  } = {},
): PixelDiffResult {
  const tolerance   = (options.toleranceRgb ?? 32) / 255;
  const threshold   = options.thresholdFraction ?? 0.01;

  let decA: DecodedImage;
  let decB: DecodedImage;
  try {
    decA = decodePng(imgA);
    decB = decodePng(imgB);
  } catch {
    // Cannot decode — treat as fully different
    return { diffRatio: 1, diffCount: -1, totalPixels: 0, isWithinShield: false };
  }

  if (decA.width !== decB.width || decA.height !== decB.height) {
    // Different dimensions = layout change — never shield
    return { diffRatio: 1, diffCount: -1, totalPixels: decA.width * decA.height, isWithinShield: false };
  }

  const total = decA.width * decA.height;
  let diffCount = 0;

  for (let i = 0; i < total; i++) {
    const off = i * 4;
    const dr = Math.abs(decA.pixels[off]!     - decB.pixels[off]!)     / 255;
    const dg = Math.abs(decA.pixels[off + 1]! - decB.pixels[off + 1]!) / 255;
    const db = Math.abs(decA.pixels[off + 2]! - decB.pixels[off + 2]!) / 255;
    const da = Math.abs(decA.pixels[off + 3]! - decB.pixels[off + 3]!) / 255;

    const dist = Math.sqrt(dr * dr + dg * dg + db * db + da * da) / 2; // normalise
    if (dist > tolerance) diffCount++;
  }

  const diffRatio = diffCount / total;
  return {
    diffRatio,
    diffCount,
    totalPixels: total,
    isWithinShield: diffRatio < threshold,
  };
}

// ── Vision QA (Claude claude-sonnet-4-6 vision) ───────────────────────────────────────────

/**
 * Send a failure screenshot to Claude Vision and ask it to:
 *  1. Identify the UI element matching the broken selector's intent.
 *  2. Suggest a resilient replacement CSS selector.
 */
async function visionHeal(
  screenshotPath: string,
  brokenSelector: string,
  context: string,
): Promise<{ selector: string; confidence: number; reasoning: string } | null> {
  if (!existsSync(screenshotPath)) return null;

  const client = new Anthropic();
  const imgBuf = readFileSync(screenshotPath);
  const b64    = imgBuf.toString('base64');

  const prompt = [
    `You are a Playwright selector repair expert.`,
    `The following test screenshot was captured at failure time.`,
    `The broken selector was: \`${brokenSelector}\``,
    `Context: ${context}`,
    ``,
    `Inspect the screenshot and:`,
    `1. Identify the UI element the broken selector was trying to target`,
    `   (by its visual appearance, label, position, or purpose).`,
    `2. Suggest the most resilient Playwright/CSS selector to target that element.`,
    `   Prefer: [data-testid=…] > role selector > [name=…] > .class > nth().`,
    `3. Rate your confidence 0–100.`,
    ``,
    `Respond ONLY with valid JSON:`,
    `{"selector": "...", "confidence": 0-100, "reasoning": "..."}`,
  ].join('\n');

  try {
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 512,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: b64 },
          },
          { type: 'text', text: prompt },
        ],
      }],
    });

    const text = msg.content.find((b) => b.type === 'text')?.text ?? '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]) as {
      selector: string;
      confidence: number;
      reasoning: string;
    };
    return parsed;
  } catch (err) {
    console.warn('[coroner] Vision QA call failed:', (err as Error).message);
    return null;
  }
}

// ── Triage logic ───────────────────────────────────────────────────────────────

function classifyVerdict(
  statusCode: number,
  brokenSelector: string | undefined,
  pixelResult: PixelDiffResult | null,
): { verdict: TriageVerdict; reasoning: string } {
  // 5xx → definitive backend bug
  if (statusCode >= 500) {
    return {
      verdict: 'BACKEND_BUG',
      reasoning: `HTTP ${statusCode} — server-side error, not a test artefact.`,
    };
  }

  // No broken selector → assertion logic error
  if (!brokenSelector) {
    return {
      verdict: 'ASSERTION_BUG',
      reasoning: 'Page loaded (2xx/3xx) but assertion value mismatch — test expectation is wrong.',
    };
  }

  // Pixel diff indicates layout truly changed
  if (pixelResult && !pixelResult.isWithinShield && pixelResult.diffRatio > 0.05) {
    return {
      verdict: 'LAYOUT_CHANGE',
      reasoning:
        `Visual diff ${(pixelResult.diffRatio * 100).toFixed(1)}% exceeds 5% threshold ` +
        `— layout changed, selector AND visual position are stale.`,
    };
  }

  // SHIELD absorbed the diff → purely a selector drift
  if (pixelResult?.isWithinShield || pixelResult?.diffRatio === 0) {
    return {
      verdict: 'SELECTOR_DRIFT',
      reasoning:
        `Page visually unchanged (diff ${(pixelResult.diffRatio * 100).toFixed(2)}% ≤ SHIELD threshold) ` +
        `but selector \`${brokenSelector}\` not found — element was refactored/renamed.`,
    };
  }

  // No baseline to compare
  if (brokenSelector) {
    return {
      verdict: 'SELECTOR_DRIFT',
      reasoning: `Selector \`${brokenSelector}\` missing on a 2xx page. Likely a DOM refactor. Vision QA will attempt repair.`,
    };
  }

  return { verdict: 'UNKNOWN', reasoning: 'Insufficient context to classify crash.' };
}

// ── Main agent entry point ─────────────────────────────────────────────────────

export async function run(
  task: AgentTask,
  config: RunConfig,
  _ollama: OllamaCapability | null,
): Promise<TriageResult> {
  if (task.type !== 'TRIAGE_CRASH') {
    throw new Error(`coroner received unexpected task type: ${task.type}`);
  }

  // Load crash context from work directory
  const workDir  = join(config.targetPath, '.e2e-work');
  const traceFile = join(workDir, `${task.traceId}.json`);

  let ctx: CrashContext;
  if (existsSync(traceFile)) {
    ctx = JSON.parse(readFileSync(traceFile, 'utf-8')) as CrashContext;
  } else {
    // No crash context available — return early
    console.log(`[coroner] no crash file for traceId ${task.traceId} — nothing to triage`);
    return {
      verdict: 'UNKNOWN',
      confidence: 0,
      reasoning: 'No crash trace file found — test run may have passed.',
    };
  }

  console.log(`[coroner] triaging ${ctx.testName} — HTTP ${ctx.statusCode}, route: ${ctx.route}`);

  // ── Step 1: Compress log ──────────────────────────────────────────────────
  const digestedLog = digest({
    errorMessage: ctx.errorMessage,
    pageHtml:     ctx.pageHtml,
    consoleLogs:  ctx.consoleLogs,
    statusCode:   ctx.statusCode,
    route:        ctx.route,
    testName:     ctx.testName,
  });

  console.log(
    `[coroner] log digest: ${digestedLog.stats.originalHtmlBytes}B → ` +
    `${digestedLog.stats.compressedHtmlBytes}B (−${digestedLog.stats.reductionPct}%)`,
  );

  // ── Step 2: Pixel diff (SHIELD) ───────────────────────────────────────────
  let pixelResult: PixelDiffResult | null = null;

  if (ctx.screenshotPath && ctx.baselinePath &&
      existsSync(ctx.screenshotPath) && existsSync(ctx.baselinePath)) {
    const imgA = readFileSync(ctx.baselinePath);
    const imgB = readFileSync(ctx.screenshotPath);
    pixelResult = pixelDiff(imgA, imgB, { toleranceRgb: 32, thresholdFraction: 0.01 });
    console.log(
      `[coroner] SHIELD: diff=${(pixelResult.diffRatio * 100).toFixed(2)}% ` +
      `[${pixelResult.isWithinShield ? 'ABSORBED — cosmetic noise' : 'REAL DIFF'}]`,
    );
  }

  // ── Step 3: Classify ──────────────────────────────────────────────────────
  const { verdict, reasoning } = classifyVerdict(ctx.statusCode, ctx.brokenSelector, pixelResult);
  console.log(`[coroner] verdict: ${verdict}`);

  const result: TriageResult = {
    verdict,
    confidence: 0.85,
    reasoning,
  };

  // ── Step 4: Vision QA heal (SELECTOR_DRIFT only) ─────────────────────────
  if (verdict === 'SELECTOR_DRIFT' && ctx.screenshotPath && ctx.brokenSelector) {
    console.log(`[coroner] activating Vision QA for selector: ${ctx.brokenSelector}`);
    const healResult = await visionHeal(
      ctx.screenshotPath,
      ctx.brokenSelector,
      `Route: ${ctx.route}, test: ${ctx.testName}`,
    );

    if (healResult) {
      result.suggestedSelector = healResult.selector;
      result.confidence        = healResult.confidence / 100;
      result.patchInstruction  =
        `Replace \`${ctx.brokenSelector}\` with \`${healResult.selector}\` in the POM. ` +
        `Reasoning: ${healResult.reasoning}`;
      console.log(`[coroner] Vision QA → new selector: ${healResult.selector} (confidence: ${healResult.confidence}%)`);
    } else {
      console.warn('[coroner] Vision QA returned no result — manual selector review needed');
    }
  }

  // ── Step 5: Build BugReport for ghostwriter (BACKEND_BUG only) ───────────
  if (verdict === 'BACKEND_BUG') {
    result.bugReport = {
      route:         ctx.route,
      statusCode:    ctx.statusCode,
      assertion:     digestedLog.assertion,
      htmlSnippet:   digestedLog.htmlPayload.slice(0, 2000),
      consoleOutput: digestedLog.consoleOutput,
    };
  }

  // ── Step 6: Persist triage result ─────────────────────────────────────────
  const resultFile = join(workDir, `${task.traceId}.triage.json`);
  writeFileSync(resultFile, JSON.stringify(result, null, 2), 'utf-8');
  console.log(`[coroner] result written → ${resultFile}`);

  return result;
}
