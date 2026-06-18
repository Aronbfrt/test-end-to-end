/**
 * ghostwriter.ts — Autonomous application bug repair agent.
 *
 * Activated only when the Coroner has issued a BACKEND_BUG verdict with a
 * confirmed BugReport.  Pipeline:
 *
 *   1. LOCALISE   Read the route handler responsible for the crash.
 *   2. DIAGNOSE   Send BugReport + compressed source to Claude → patch JSON.
 *   3. BRANCH     git checkout -b e2e-patch/<timestamp>-<route-slug>
 *   4. APPLY      Write the patch to disk (surgical line-level diff).
 *   5. VERIFY     Re-run the failing test via `npx playwright test`.
 *   6. PR         gh pr create (or GitHub REST API as fallback) with full report.
 */

import Anthropic from '@anthropic-ai/sdk';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { AgentTask, BugReport, RunConfig } from '../orchestrator.js';
import { anthropicLimiter } from '../orchestrator.js';

// ── Types ──────────────────────────────────────────────────────────────────────

interface OllamaCapability {
  available: boolean;
  model: string | null;
  endpoint: string;
}

interface Patch {
  /** Absolute path of the file to modify. */
  filePath: string;
  /** Exact string to find (must be unique in the file). */
  oldCode: string;
  /** Replacement string. */
  newCode: string;
  /** One-line explanation of the fix. */
  explanation: string;
}

interface GhostwriterResult {
  success: boolean;
  branch: string;
  prUrl?: string;
  patchedFiles: string[];
  verificationPassed: boolean;
  reasoning: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function slugify(str: string): string {
  return str.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').slice(0, 40).toLowerCase();
}

function git(root: string, args: string[]): string {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      timeout: 30_000,
      encoding: 'utf-8',
    }).toString().trim();
  } catch (e) {
    throw new Error(`git ${args.join(' ')}: ${(e as Error).message}`);
  }
}

/**
 * Find the source file most likely responsible for the crashed route.
 * Strategy (in order of confidence):
 *   1. Files whose path contains the route slug.
 *   2. Files containing the route string as a literal.
 *   3. Fallback: return empty list — Claude will be told no file found.
 */
function locateHandler(targetPath: string, route: string): string[] {
  const slug = route.replace(/^\//, '').replace(/\//g, '/');
  const candidates: string[] = [];

  // Structural match
  try {
    const out = execFileSync('find', [
      targetPath, '-type', 'f',
      '(', '-name', '*.ts', '-o', '-name', '*.js', '-o', '-name', '*.py', '-o', '-name', '*.php', ')',
      '-not', '-path', '*/node_modules/*',
      '-not', '-path', '*/.git/*',
      '-not', '-path', '*/dist/*',
    ], { timeout: 5000, encoding: 'utf-8' });
    for (const f of out.split('\n').filter(Boolean)) {
      if (f.includes(slug)) candidates.push(f);
    }
  } catch { /* ignore */ }

  // Grep for route string
  if (candidates.length === 0) {
    try {
      const out = execFileSync('grep', [
        '-rl', route, targetPath,
        '--include=*.ts', '--include=*.js', '--include=*.py', '--include=*.php',
        '--exclude-dir=node_modules', '--exclude-dir=.git', '--exclude-dir=dist',
      ], { timeout: 5000, encoding: 'utf-8' });
      candidates.push(...out.split('\n').filter(Boolean));
    } catch { /* ignore */ }
  }

  return candidates.slice(0, 3); // cap at 3 to avoid overwhelming the LLM
}

// ── Claude patch generation ────────────────────────────────────────────────────

async function generatePatch(
  bugReport: BugReport,
  sourceFiles: Array<{ path: string; content: string }>,
): Promise<Patch[]> {
  const client = new Anthropic();

  const filesBlock = sourceFiles.map((f) => [
    `### FILE: ${f.path}`,
    '```',
    f.content.slice(0, 6000), // cap per file to stay in budget
    '```',
  ].join('\n')).join('\n\n');

  const prompt = `You are a surgical bug-fix agent. A backend crash was detected by automated E2E tests.

## Bug Report
Route:         ${bugReport.route}
HTTP Status:   ${bugReport.statusCode}
Assertion:     ${bugReport.assertion}
Console output:
${bugReport.consoleOutput.slice(0, 1000)}

DOM snapshot (Byte-State compressed):
${bugReport.htmlSnippet.slice(0, 1000)}

## Responsible Source Files
${filesBlock}

## Task
1. Identify the exact bug in the source code above.
2. Write a MINIMAL surgical fix — change as few lines as possible.
3. Return a JSON array of patch objects ONLY — no explanatory text outside JSON.

Each patch object must have:
{
  "filePath": "<absolute path from the file headers above>",
  "oldCode": "<exact verbatim string to replace — must be unique in the file>",
  "newCode": "<replacement string>",
  "explanation": "<one sentence: what was wrong and how this fixes it>"
}

IMPORTANT:
- oldCode must be an EXACT copy from the source (whitespace-sensitive).
- If the bug cannot be confidently identified, return [].
- Never add console.log or debug code.
- Never change public API signatures.`;

  await anthropicLimiter.acquire();
  const msg = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = msg.content.find((b) => b.type === 'text')?.text ?? '';
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];

  try {
    return JSON.parse(jsonMatch[0]) as Patch[];
  } catch {
    return [];
  }
}

// ── Patch application ──────────────────────────────────────────────────────────

function applyPatch(patch: Patch): boolean {
  if (!existsSync(patch.filePath)) {
    console.warn(`[ghostwriter] patch target not found: ${patch.filePath}`);
    return false;
  }
  const src = readFileSync(patch.filePath, 'utf-8');
  if (!src.includes(patch.oldCode)) {
    console.warn(`[ghostwriter] oldCode not found in ${patch.filePath} — skipping`);
    return false;
  }
  const patched = src.replace(patch.oldCode, patch.newCode);
  writeFileSync(patch.filePath, patched, 'utf-8');
  return true;
}

// ── Test verification ──────────────────────────────────────────────────────────

function runVerification(targetPath: string, route: string): boolean {
  const grepSlug = slugify(route);
  try {
    const result = spawnSync(
      'npx',
      ['playwright', 'test', '--grep', grepSlug, '--reporter=line'],
      {
        cwd: targetPath,
        timeout: 120_000,
        encoding: 'utf-8',
        env: { ...process.env, CI: '1' },
      },
    );
    return result.status === 0;
  } catch {
    return false;
  }
}

// ── PR creation ────────────────────────────────────────────────────────────────

function createPr(
  targetPath: string,
  branch: string,
  bugReport: BugReport,
  patches: Patch[],
  verificationPassed: boolean,
): string | undefined {
  const patchSummary = patches.map((p) => `- \`${p.filePath}\`: ${p.explanation}`).join('\n');
  const body = [
    `## 🤖 Autonomous E2E Patch`,
    ``,
    `**Route:** \`${bugReport.route}\`  `,
    `**HTTP status at failure:** ${bugReport.statusCode}  `,
    `**Broken assertion:** \`${bugReport.assertion}\`  `,
    ``,
    `### Changes`,
    patchSummary,
    ``,
    `### Verification`,
    verificationPassed
      ? `✅ Re-run of the failing test passed after patch.`
      : `⚠️ Verification run did not fully pass — human review recommended.`,
    ``,
    `### Console output at failure`,
    '```',
    bugReport.consoleOutput.slice(0, 500),
    '```',
    ``,
    `_Generated autonomously by test-end-to-end ghostwriter agent._`,
  ].join('\n');

  const title = `fix(e2e-patch): ${bugReport.route} — ${bugReport.assertion.slice(0, 60)}`;

  // Try gh CLI first
  try {
    const prUrl = execFileSync(
      'gh', ['pr', 'create',
        '--title', title,
        '--body', body,
        '--head', branch,
        '--label', 'e2e-patch,autonomous-fix',
      ],
      { cwd: targetPath, timeout: 30_000, encoding: 'utf-8' },
    ).toString().trim();
    return prUrl;
  } catch {
    // Fallback: write a local patch-report file so the user can open the PR manually
    const reportPath = join(targetPath, `.e2e-work/pr-${branch.replace(/\//g, '-')}.md`);
    writeFileSync(reportPath, `# PR Draft\n\n**Title:** ${title}\n\n${body}`, 'utf-8');
    console.warn(`[ghostwriter] gh CLI not available — PR draft saved to ${reportPath}`);
    return undefined;
  }
}

// ── Main agent entry point ─────────────────────────────────────────────────────

export async function run(
  task: AgentTask,
  config: RunConfig,
  _ollama: OllamaCapability | null,
): Promise<GhostwriterResult> {
  if (task.type !== 'WRITE_PATCH') {
    throw new Error(`ghostwriter received unexpected task type: ${task.type}`);
  }

  const bug = task.bugReport;
  const root = config.targetPath;
  const branchName = `e2e-patch/${Date.now()}-${slugify(bug.route)}`;

  console.log(`[ghostwriter] bug confirmed: ${bug.route} (HTTP ${bug.statusCode})`);

  // ── Step 1: Localise handler ───────────────────────────────────────────────
  const handlerFiles = locateHandler(root, bug.route);
  console.log(`[ghostwriter] handler candidates: ${handlerFiles.length} files`);

  if (handlerFiles.length === 0) {
    return {
      success: false,
      branch: '',
      patchedFiles: [],
      verificationPassed: false,
      reasoning: `No source file found for route ${bug.route} — cannot generate patch.`,
    };
  }

  const sourceFiles = handlerFiles
    .filter(existsSync)
    .map((f) => ({ path: f, content: readFileSync(f, 'utf-8') }));

  // ── Step 2: Generate patch ─────────────────────────────────────────────────
  console.log('[ghostwriter] calling Claude for patch generation …');
  let patches: Patch[] = [];
  try {
    patches = await generatePatch(bug, sourceFiles);
  } catch (err) {
    console.error('[ghostwriter] patch generation failed:', (err as Error).message);
    return {
      success: false,
      branch: '',
      patchedFiles: [],
      verificationPassed: false,
      reasoning: `Claude patch generation error: ${(err as Error).message}`,
    };
  }

  if (patches.length === 0) {
    return {
      success: false,
      branch: '',
      patchedFiles: [],
      verificationPassed: false,
      reasoning: 'Claude could not identify the bug with sufficient confidence.',
    };
  }

  // ── Dry-run gate (default) — write pending patch JSON, do NOT touch files ──
  const patchId = `patch-${Date.now()}`;
  if (!config.applyPatches) {
    const pendingDir = join(root, '.e2e-work', 'patches-pending');
    if (!existsSync(pendingDir)) mkdirSync(pendingDir, { recursive: true });
    const pendingPath = join(pendingDir, `${patchId}.patch.json`);
    writeFileSync(
      pendingPath,
      JSON.stringify({ patchId, generatedAt: new Date().toISOString(), bug, patches }, null, 2),
      'utf-8',
    );
    console.log(`[ghostwriter] dry-run: ${patches.length} patch(es) saved → ${pendingPath}`);
    console.log('[ghostwriter] re-run with --apply flag to apply patches and open PR');
    return {
      success: true,
      branch: '',
      patchedFiles: [],
      verificationPassed: false,
      reasoning: `Dry-run: ${patches.length} patch(es) pending at ${pendingPath}`,
    };
  }

  // ── Step 3: Create branch ──────────────────────────────────────────────────
  try {
    git(root, ['checkout', '-b', branchName]);
    console.log(`[ghostwriter] branch: ${branchName}`);
  } catch (err) {
    return {
      success: false,
      branch: branchName,
      patchedFiles: [],
      verificationPassed: false,
      reasoning: `Git branch creation failed: ${(err as Error).message}`,
    };
  }

  // ── Step 4: Apply patches ──────────────────────────────────────────────────
  const patchedFiles: string[] = [];
  for (const patch of patches) {
    if (applyPatch(patch)) {
      patchedFiles.push(patch.filePath);
      console.log(`[ghostwriter] patched: ${patch.filePath} — ${patch.explanation}`);
    }
  }

  if (patchedFiles.length === 0) {
    git(root, ['checkout', '-']);
    git(root, ['branch', '-D', branchName]);
    return {
      success: false,
      branch: branchName,
      patchedFiles: [],
      verificationPassed: false,
      reasoning: 'All patches failed to apply (oldCode not found in source).',
    };
  }

  // Commit the patch
  try {
    git(root, ['add', ...patchedFiles]);
    git(root, ['commit', '-m',
      `fix(e2e-patch): ${bug.route} — ${patches[0]!.explanation.slice(0, 72)}\n\n` +
      `Autonomous patch by test-end-to-end ghostwriter.\n` +
      `Broken assertion: ${bug.assertion}\n` +
      `HTTP status at failure: ${bug.statusCode}`,
    ]);
  } catch (err) {
    console.warn('[ghostwriter] commit failed:', (err as Error).message);
  }

  // ── Step 5: Verify ─────────────────────────────────────────────────────────
  console.log('[ghostwriter] running verification test suite …');
  const verificationPassed = runVerification(root, bug.route);
  console.log(`[ghostwriter] verification: ${verificationPassed ? 'PASSED ✓' : 'FAILED ✗'}`);

  // Push branch
  try {
    git(root, ['push', '--set-upstream', 'origin', branchName]);
  } catch {
    console.warn('[ghostwriter] push failed — PR will reference local branch only');
  }

  // ── Step 6: Open PR ────────────────────────────────────────────────────────
  const prUrl = createPr(root, branchName, bug, patches, verificationPassed);
  if (prUrl) console.log(`[ghostwriter] PR opened: ${prUrl}`);

  return {
    success: true,
    branch: branchName,
    prUrl,
    patchedFiles,
    verificationPassed,
    reasoning: patches.map((p) => p.explanation).join('; '),
  };
}
