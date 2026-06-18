/**
 * evolver.ts — Meta-programming self-improvement agent.
 *
 * Activated when:
 *   a) An agent task fails with an unrecoverable error.
 *   b) The Scout encounters a completely unknown stack.
 *   c) The Coroner reaches UNKNOWN verdict repeatedly (≥ 3 times).
 *
 * What it does:
 *   1. READ    Ingest the failure log + the source of the failed agent.
 *   2. ANALYSE Send both to Claude → structured critique JSON.
 *   3. PATCH   Apply suggested improvements to /src TypeScript files.
 *   4. COMMIT  Commit the self-patch to the current branch (no new PR —
 *              the improvement is internal tooling, not application code).
 *   5. RECORD  Append to .e2e-work/evolution-log.jsonl for observability.
 */

import Anthropic from '@anthropic-ai/sdk';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

import type { AgentTask, RunConfig } from '../orchestrator.js';
import { anthropicLimiter } from '../orchestrator.js';

// ── Types ──────────────────────────────────────────────────────────────────────

interface OllamaCapability {
  available: boolean;
  model: string | null;
  endpoint: string;
}

interface EvolutionEntry {
  ts: number;
  failedTaskType: string;
  reason: string;
  filesPatched: string[];
  success: boolean;
}

interface AgentCritique {
  /** Agent module name (e.g. "scout", "coroner"). */
  agentModule: string;
  /** What specifically caused the failure. */
  rootCause: string;
  /** Ordered list of improvements to apply. */
  improvements: Array<{
    filePath: string;
    oldCode: string;
    newCode: string;
    rationale: string;
  }>;
  /** New system-level prompt to store if the issue is prompt-quality. */
  revisedPrompt?: string;
}

// ── Source reader ──────────────────────────────────────────────────────────────

function readAgentSource(agentModule: string, srcRoot: string): string | null {
  const candidates = [
    join(srcRoot, 'agents', `${agentModule}.ts`),
    join(srcRoot, 'utils',  `${agentModule}.ts`),
    join(srcRoot, `${agentModule}.ts`),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return readFileSync(c, 'utf-8');
  }
  return null;
}

function inferAgentModule(task: AgentTask): string {
  switch (task.type) {
    case 'SCAN_AST':     return 'scout';
    case 'GEN_TESTS':    return 'artisan';
    case 'TRIAGE_CRASH': return 'coroner';
    case 'WRITE_PATCH':  return 'ghostwriter';
    case 'SELF_EVOLVE':  return 'evolver';
  }
}

// ── Critique generation ────────────────────────────────────────────────────────

async function generateCritique(
  failedTask: AgentTask,
  reason: string,
  agentSource: string,
  evolutionHistory: EvolutionEntry[],
): Promise<AgentCritique | null> {
  const client = new Anthropic();
  const agentModule = inferAgentModule(failedTask.type === 'SELF_EVOLVE'
    ? (failedTask as { failedTask: AgentTask }).failedTask
    : failedTask);

  const historyBlock = evolutionHistory.slice(-5).map((e) =>
    `- [${new Date(e.ts).toISOString()}] ${e.failedTaskType}: ${e.reason} → ${e.success ? 'fixed' : 'failed again'}`,
  ).join('\n');

  const prompt = `You are a meta-programming agent that improves its own TypeScript source code.

## Failed agent: ${agentModule}
## Failure reason
${reason}

## Failed task payload
${JSON.stringify(failedTask, null, 2).slice(0, 1000)}

## Agent source (${agentModule}.ts)
\`\`\`typescript
${agentSource.slice(0, 8000)}
\`\`\`

## Recent evolution history
${historyBlock || 'None'}

## Task
Analyse the failure reason and the source code.
Identify the minimal, targeted changes that would prevent this class of failure.

Respond ONLY with valid JSON (no text outside):
{
  "agentModule": "${agentModule}",
  "rootCause": "<one sentence>",
  "improvements": [
    {
      "filePath": "<absolute path as it appears in the source>",
      "oldCode": "<exact verbatim string — whitespace-sensitive>",
      "newCode": "<replacement>",
      "rationale": "<one sentence>"
    }
  ],
  "revisedPrompt": "<optional — only if issue is a prompt quality problem>"
}

Rules:
- oldCode must be an exact substring of the source shown.
- Suggest at most 3 improvements.
- Never introduce new external dependencies.
- Never add debug logging.
- If the failure is environmental (network, OS, missing binary), return {"agentModule":"${agentModule}","rootCause":"environmental","improvements":[]}.`;

  try {
    await anthropicLimiter.acquire();
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = msg.content.find((b) => b.type === 'text')?.text ?? '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]) as AgentCritique;
  } catch (err) {
    console.warn('[evolver] critique generation failed:', (err as Error).message);
    return null;
  }
}

// ── Apply self-patch ───────────────────────────────────────────────────────────

function applyImprovement(
  imp: AgentCritique['improvements'][number],
  srcRoot: string,
): boolean {
  // Resolve relative paths against src root
  let absPath = imp.filePath;
  if (!existsSync(absPath)) {
    absPath = join(srcRoot, imp.filePath);
  }
  if (!existsSync(absPath)) {
    console.warn(`[evolver] target not found: ${imp.filePath}`);
    return false;
  }

  const src = readFileSync(absPath, 'utf-8');
  if (!src.includes(imp.oldCode)) {
    console.warn(`[evolver] oldCode not found in ${absPath}`);
    return false;
  }

  const patched = src.replace(imp.oldCode, imp.newCode);
  writeFileSync(absPath, patched, 'utf-8');
  console.log(`[evolver] self-patched: ${absPath} — ${imp.rationale}`);
  return true;
}

// ── Revised prompt storage ─────────────────────────────────────────────────────

function storeRevisedPrompt(agentModule: string, prompt: string, workDir: string): void {
  const dir = join(workDir, 'prompts');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${agentModule}.system.txt`), prompt, 'utf-8');
  console.log(`[evolver] revised system prompt stored for ${agentModule}`);
}

// ── Git commit self-patch ──────────────────────────────────────────────────────

function commitSelfPatch(root: string, files: string[], agentModule: string): void {
  try {
    execFileSync('git', ['-C', root, 'add', ...files], { timeout: 10_000 });
    execFileSync('git', ['-C', root, 'commit', '-m',
      `refactor(evolver): self-patch ${agentModule} — autonomous improvement\n\n` +
      `Applied by evolver.ts after runtime failure analysis.`,
    ], { timeout: 10_000 });
    console.log('[evolver] self-patch committed');
  } catch (err) {
    console.warn('[evolver] git commit failed:', (err as Error).message);
  }
}

// ── Evolution log ──────────────────────────────────────────────────────────────

function appendEvolutionLog(entry: EvolutionEntry, workDir: string): void {
  const logPath = join(workDir, 'evolution-log.jsonl');
  appendFileSync(logPath, JSON.stringify(entry) + '\n', 'utf-8');
}

function loadEvolutionHistory(workDir: string): EvolutionEntry[] {
  const logPath = join(workDir, 'evolution-log.jsonl');
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try { return JSON.parse(l) as EvolutionEntry; } catch { return null; }
    })
    .filter((e): e is EvolutionEntry => e !== null);
}

// ── Main agent entry point ─────────────────────────────────────────────────────

export async function run(
  task: AgentTask,
  config: RunConfig,
  _ollama: OllamaCapability | null,
): Promise<{ filesPatched: string[]; success: boolean }> {
  if (task.type !== 'SELF_EVOLVE') {
    throw new Error(`evolver received unexpected task type: ${task.type}`);
  }

  const { failedTask, reason } = task;
  const root    = config.targetPath;
  const srcRoot = join(root, 'src');
  const workDir = join(root, '.e2e-work');

  if (!existsSync(workDir)) mkdirSync(workDir, { recursive: true });

  const agentModule = inferAgentModule(failedTask);
  console.log(`[evolver] analysing failure of ${agentModule}: ${reason.slice(0, 120)}`);

  // ── Load agent source ──────────────────────────────────────────────────────
  const agentSource = readAgentSource(agentModule, srcRoot);
  if (!agentSource) {
    console.warn(`[evolver] source not found for ${agentModule} — cannot self-evolve`);
    appendEvolutionLog({
      ts: Date.now(), failedTaskType: failedTask.type, reason,
      filesPatched: [], success: false,
    }, workDir);
    return { filesPatched: [], success: false };
  }

  // ── Load history ───────────────────────────────────────────────────────────
  const history = loadEvolutionHistory(workDir);

  // Guard: if we've already tried to fix this 3× and keep failing, bail out
  const recentFailures = history.filter(
    (e) => e.failedTaskType === failedTask.type && !e.success &&
    Date.now() - e.ts < 24 * 3600 * 1000,
  );
  if (recentFailures.length >= 3) {
    console.warn(`[evolver] ${agentModule} failed 3× in 24h — escalating to human`);
    appendEvolutionLog({
      ts: Date.now(), failedTaskType: failedTask.type,
      reason: 'Max retry limit reached — requires human intervention',
      filesPatched: [], success: false,
    }, workDir);
    return { filesPatched: [], success: false };
  }

  // ── Generate critique ──────────────────────────────────────────────────────
  const critique = await generateCritique(failedTask, reason, agentSource, history);
  if (!critique || critique.improvements.length === 0) {
    if (critique?.rootCause === 'environmental') {
      console.log('[evolver] environmental failure — no source patch needed');
    } else {
      console.warn('[evolver] no improvements suggested');
    }
    appendEvolutionLog({
      ts: Date.now(), failedTaskType: failedTask.type, reason,
      filesPatched: [], success: false,
    }, workDir);
    return { filesPatched: [], success: false };
  }

  console.log(`[evolver] root cause: ${critique.rootCause}`);

  // ── Supervised gate (default: ON) ──────────────────────────────────────────
  const supervised = config.supervised !== false;
  if (supervised) {
    const pendingDir = join(workDir, 'evolutions-pending');
    if (!existsSync(pendingDir)) mkdirSync(pendingDir, { recursive: true });
    const pendingPath = join(pendingDir, `${Date.now()}-${agentModule}.evolution.json`);
    writeFileSync(
      pendingPath,
      JSON.stringify({
        ts: Date.now(),
        agentModule,
        failedTaskType: failedTask.type,
        reason,
        critique,
      }, null, 2),
      'utf-8',
    );
    console.log(`[evolver] supervised: evolution proposal saved → ${pendingPath}`);
    console.log('[evolver] apply with: node dist/index.js e2e-evolve-apply <file>');
    appendEvolutionLog({ ts: Date.now(), failedTaskType: failedTask.type, reason, filesPatched: [], success: false }, workDir);
    return { filesPatched: [], success: false };
  }

  console.warn(
    '[evolver] ⚠️  UNSUPERVISED MODE ACTIVE — self-patches applied directly to plugin source without human review. ' +
    'Pass config.supervised=true (or omit) to gate changes behind e2e-evolve-apply.',
  );

  // ── Apply improvements ─────────────────────────────────────────────────────
  const patchedFiles: string[] = [];
  for (const imp of critique.improvements) {
    if (applyImprovement(imp, srcRoot)) {
      let absPath = imp.filePath;
      if (!existsSync(absPath)) absPath = join(srcRoot, imp.filePath);
      patchedFiles.push(absPath);
    }
  }

  // ── Store revised prompt ───────────────────────────────────────────────────
  if (critique.revisedPrompt) {
    storeRevisedPrompt(agentModule, critique.revisedPrompt, workDir);
  }

  const success = patchedFiles.length > 0;

  // ── Commit ─────────────────────────────────────────────────────────────────
  if (success) {
    commitSelfPatch(root, patchedFiles, agentModule);
  }

  // ── Record ─────────────────────────────────────────────────────────────────
  appendEvolutionLog({
    ts: Date.now(), failedTaskType: failedTask.type, reason,
    filesPatched: patchedFiles, success,
  }, workDir);

  console.log(`[evolver] done — ${patchedFiles.length} files patched, success: ${success}`);
  return { filesPatched: patchedFiles, success };
}
