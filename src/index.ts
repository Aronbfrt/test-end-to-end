/**
 * index.ts — Universal CLI + MCP server entry point.
 *
 * Two modes:
 *  A. CLI mode  — invoked directly: `node dist/index.js audit --level=2`
 *  B. MCP mode  — invoked by Claude Code or a parent AI agent.
 *     Every command is registered as a native MCP tool so other AI instances
 *     can call them with typed JSON arguments (nested orchestration).
 *
 * Flags:
 *   --level=1  Deterministic local (AST-only, no LLM)
 *   --level=2  Hybrid cognitive (default — Vision QA on selector failure)
 *   --level=3  Meta-Agent Infinite (full: Shadow Personas, Ghostwriter, Evolver)
 *   --chaos    Inject fault scenarios (double-clicks, mid-payment disconnects, i18n)
 *   --predictive  Activate Git forensics hotspot detection (--level=2+ only)
 */

import { resolve } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';

import type { Level, RunConfig } from './orchestrator.js';
import { run, diagnostics } from './orchestrator.js';

// ── CLI argument parsing ───────────────────────────────────────────────────────

interface ParsedArgs {
  command: RunConfig['command'] | null;
  level: Level;
  chaos: boolean;
  predictive: boolean;
  resetCache: boolean;
  mcp: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);          // drop 'node' + script path

  const levelArg = args.find((a) => a.startsWith('--level='));
  const rawLevel = levelArg ? parseInt(levelArg.split('=')[1] ?? '2', 10) : 2;
  const level: Level = ([1, 2, 3] as Level[]).includes(rawLevel as Level)
    ? (rawLevel as Level)
    : 2;

  const validCommands: Array<RunConfig['command']> = [
    'init', 'audit', 'shadow', 'diff', 'repair',
  ];
  const command = (args.find((a) => validCommands.includes(a as RunConfig['command'])) ?? null) as RunConfig['command'] | null;

  return {
    command,
    level,
    chaos:      args.includes('--chaos'),
    predictive: args.includes('--predictive'),
    resetCache: args.includes('--reset-cache'),
    mcp:        args.includes('--mcp') || process.env.MCP_MODE === '1',
  };
}

// ── MCP tool definitions ───────────────────────────────────────────────────────

const TOOLS: Tool[] = [
  {
    name: 'e2e_init',
    description:
      'Initialise the autonomous QA ecosystem on the target repository. ' +
      'Detects stack, seeds the cache, and scaffolds the test infrastructure.',
    inputSchema: {
      type: 'object',
      properties: {
        targetPath: { type: 'string', description: 'Absolute path to the target repo root.' },
        level:      { type: 'number', enum: [1, 2, 3], description: 'Processing level (default 2).' },
      },
      required: ['targetPath'],
    },
  },
  {
    name: 'e2e_audit',
    description:
      'Run a full E2E audit: route discovery, test generation, auto-fix loop, final report. ' +
      'Set level=3 to enable Shadow Personas, Ghostwriter and Evolver.',
    inputSchema: {
      type: 'object',
      properties: {
        targetPath:  { type: 'string' },
        level:       { type: 'number', enum: [1, 2, 3] },
        chaos:       { type: 'boolean', description: 'Inject fault scenarios.' },
        predictive:  { type: 'boolean', description: 'Enable Git forensics hotspot detection.' },
      },
      required: ['targetPath'],
    },
  },
  {
    name: 'e2e_shadow',
    description:
      'Zero-prompt Reverse Testing + Shadow Personas. ' +
      'The Scout deconstructs the AST and the Artisan generates 100% inferred E2E coverage ' +
      'using cognitive extreme user profiles.',
    inputSchema: {
      type: 'object',
      properties: {
        targetPath: { type: 'string' },
        level:      { type: 'number', enum: [1, 2, 3] },
      },
      required: ['targetPath'],
    },
  },
  {
    name: 'e2e_diff',
    description:
      'Scope the test run to the current git diff. ' +
      'With predictive=true, activates 12-month Git forensics to find Psychological Code Hotspots.',
    inputSchema: {
      type: 'object',
      properties: {
        targetPath:  { type: 'string' },
        predictive:  { type: 'boolean' },
        level:       { type: 'number', enum: [1, 2, 3] },
      },
      required: ['targetPath'],
    },
  },
  {
    name: 'e2e_repair',
    description:
      'Activate the Ghostwriter agent to write a surgical fix for a confirmed application bug, ' +
      'push a documented Pull Request, and verify the fix with a targeted re-run.',
    inputSchema: {
      type: 'object',
      properties: {
        targetPath:  { type: 'string' },
        bugReport: {
          type: 'object',
          description: 'BugReport JSON produced by the Coroner agent.',
          properties: {
            route:         { type: 'string' },
            statusCode:    { type: 'number' },
            assertion:     { type: 'string' },
            htmlSnippet:   { type: 'string' },
            consoleOutput: { type: 'string' },
          },
          required: ['route', 'statusCode', 'assertion', 'htmlSnippet', 'consoleOutput'],
        },
      },
      required: ['targetPath', 'bugReport'],
    },
  },
  {
    name: 'e2e_diagnostics',
    description:
      'Return the current orchestrator state, Ollama capability, and cache snapshot. ' +
      'Useful for nested AI agents checking system health before delegating tasks.',
    inputSchema: { type: 'object', properties: {} },
  },
];

// ── MCP tool handler ───────────────────────────────────────────────────────────

async function handleToolCall(
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const ok = (payload: unknown) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
  });
  const err = (msg: string) => ({
    content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }],
    isError: true,
  });

  if (toolName === 'e2e_diagnostics') {
    return ok(diagnostics());
  }

  const targetPath = resolve((args.targetPath as string | undefined) ?? process.cwd());
  const level = ([1, 2, 3] as Level[]).includes((args.level as Level)) ? (args.level as Level) : 2;
  const chaos = Boolean(args.chaos);
  const predictive = Boolean(args.predictive);

  const commandMap: Record<string, RunConfig['command']> = {
    e2e_init:   'init',
    e2e_audit:  'audit',
    e2e_shadow: 'shadow',
    e2e_diff:   'diff',
    e2e_repair: 'repair',
  };
  const command = commandMap[toolName];
  if (!command) return err(`Unknown tool: ${toolName}`);

  try {
    await run({ command, level, chaos, predictive, targetPath });
    return ok({ status: 'done', command, level, targetPath });
  } catch (e) {
    return err((e as Error).message);
  }
}

// ── MCP server bootstrap ───────────────────────────────────────────────────────

async function startMcpServer(): Promise<void> {
  const server = new Server(
    {
      name:    'test-end-to-end',
      version: '0.1.0',
    },
    {
      capabilities: { tools: {} },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: rawArgs } = req.params;
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    return handleToolCall(name, args);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[mcp] test-end-to-end server listening on stdio');
}

// ── CLI runner ─────────────────────────────────────────────────────────────────

async function runCli(parsed: ParsedArgs): Promise<void> {
  if (!parsed.command) {
    console.error(
      'Usage: e2e <command> [--level=1|2|3] [--chaos] [--predictive]\n' +
      'Commands: init | audit | shadow | diff | repair\n' +
      'Flags:    --mcp (start as MCP server) | --reset-cache',
    );
    process.exit(1);
  }

  if (parsed.resetCache) {
    const { clearCache, persistCache } = await import('./utils/cache.js');
    clearCache();
    persistCache();
    console.log('[cache] cleared');
  }

  await run({
    command:    parsed.command,
    level:      parsed.level,
    chaos:      parsed.chaos,
    predictive: parsed.predictive,
    targetPath: resolve(process.cwd()),
  });
}

// ── Entry point ────────────────────────────────────────────────────────────────

const parsed = parseArgs(process.argv);

if (parsed.mcp) {
  startMcpServer().catch((e) => {
    console.error('[mcp] fatal:', e);
    process.exit(1);
  });
} else {
  runCli(parsed).catch((e) => {
    console.error('[cli] fatal:', e);
    process.exit(1);
  });
}
