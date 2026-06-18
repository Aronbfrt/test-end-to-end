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
  command:    RunConfig['command'] | null;
  level:      Level;
  chaos:      boolean;
  predictive: boolean;
  resetCache: boolean;
  mcp:        boolean;
  traceId?:   string;
  dryRun:     boolean;
  detail:     boolean;
  targetPath?: string;
  prNumber?:  number;
  repo?:      string;
  port?:      number;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);          // drop 'node' + script path

  const levelArg = args.find((a) => a.startsWith('--level='));
  const rawLevel = levelArg ? parseInt(levelArg.split('=')[1] ?? '2', 10) : 2;
  const level: Level = ([1, 2, 3] as Level[]).includes(rawLevel as Level)
    ? (rawLevel as Level)
    : 2;

  const traceArg = args.find((a) => a.startsWith('--trace='));
  const traceId = traceArg ? traceArg.split('=').slice(1).join('=') : undefined;

  const validCommands: Array<RunConfig['command']> = [
    'init', 'audit', 'shadow', 'diff', 'repair', 'coverage', 'update',
    'sentinel', 'arch', 'chaos',
  ];
  const command = (args.find((a) => validCommands.includes(a as RunConfig['command'])) ?? null) as RunConfig['command'] | null;

  const prArg = args.find((a) => a.startsWith('--pr='));
  const prNumber = prArg ? parseInt(prArg.split('=')[1] ?? '0', 10) : undefined;
  const repoArg = args.find((a) => a.startsWith('--repo='));
  const repo = repoArg ? repoArg.split('=').slice(1).join('=') : undefined;
  const portArg = args.find((a) => a.startsWith('--port='));
  const port = portArg ? parseInt(portArg.split('=')[1] ?? '3000', 10) : undefined;

  // First non-flag, non-command positional arg = targetPath override
  const targetPath = args.find((a) => !a.startsWith('-') && !validCommands.includes(a as RunConfig['command']));

  return {
    command,
    level,
    chaos:      args.includes('--chaos'),
    predictive: args.includes('--predictive'),
    resetCache: args.includes('--reset-cache'),
    mcp:        args.includes('--mcp') || process.env.MCP_MODE === '1',
    traceId,
    dryRun:     args.includes('--dry-run'),
    detail:     args.includes('--detail'),
    targetPath,
    prNumber,
    repo,
    port,
  };
}

// ── MCP tool definitions ───────────────────────────────────────────────────────

const TOOLS: Tool[] = [
  {
    name: 'e2e_coverage',
    description:
      'Map all routes and forms against existing test files. Returns coverage %, gaps list, ' +
      'and generates .e2e-work/coverage.html. Use after audit or update to verify test health.',
    inputSchema: {
      type: 'object',
      properties: {
        targetPath: { type: 'string', description: 'Absolute path to the target repo root.' },
        detail:     { type: 'boolean', description: 'Include per-route file matches in output.' },
      },
      required: ['targetPath'],
    },
  },
  {
    name: 'e2e_update',
    description:
      'Sync tests after code changes. Compares current route map against the last snapshot ' +
      'and generates tests only for new/changed routes. Protects manual tests.',
    inputSchema: {
      type: 'object',
      properties: {
        targetPath: { type: 'string' },
        dryRun:     { type: 'boolean', description: 'Show diff without writing any file.' },
        level:      { type: 'number', enum: [1, 2, 3] },
      },
      required: ['targetPath'],
    },
  },
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
      'push a documented Pull Request, and verify the fix with a targeted re-run. ' +
      'Pass traceId to load a triage from disk, or bugReport directly.',
    inputSchema: {
      type: 'object',
      properties: {
        targetPath: { type: 'string' },
        traceId:    { type: 'string', description: 'Load triage from .e2e-work/<traceId>.triage.json.' },
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
      required: ['targetPath'],
    },
  },
  {
    name: 'e2e_diagnostics',
    description:
      'Return the current orchestrator state, Ollama capability, and cache snapshot. ' +
      'Useful for nested AI agents checking system health before delegating tasks.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'e2e_sentinel',
    description:
      'Security audit of open GitHub Pull Requests. Detects OWASP Top 10 vulnerabilities, ' +
      'hardcoded secrets, backdoors, and logic flaws using local LLM or static regex. ' +
      'Posts APPROVE / COMMENT / REQUEST_CHANGES review to GitHub.',
    inputSchema: {
      type: 'object',
      properties: {
        targetPath: { type: 'string' },
        prNumber:   { type: 'number', description: 'Audit a specific PR number only.' },
        repo:       { type: 'string', description: 'GitHub repo slug (owner/repo). Auto-detected if absent.' },
      },
      required: ['targetPath'],
    },
  },
  {
    name: 'e2e_arch',
    description:
      'Static architectural analysis: cyclomatic complexity, excessive coupling, oversized files, ' +
      'implicit `any`, missing return types. Returns a 0–100 score with grade A–F and ' +
      'an LLM-generated refactoring plan.',
    inputSchema: {
      type: 'object',
      properties: {
        targetPath: { type: 'string' },
      },
      required: ['targetPath'],
    },
  },
  {
    name: 'e2e_chaos',
    description:
      'Generate Playwright chaos specs for all routes: LATENCY, TIMEOUT, ERROR_50x, OFFLINE, ' +
      'CORRUPT (malformed JSON), PARTIAL (truncated response). Tests app resilience under network failure.',
    inputSchema: {
      type: 'object',
      properties: {
        targetPath: { type: 'string' },
        scenarios: {
          type: 'array',
          items: { type: 'string', enum: ['LATENCY', 'TIMEOUT', 'ERROR_50x', 'OFFLINE', 'CORRUPT', 'PARTIAL'] },
          description: 'Scenarios to inject (default: all 6).',
        },
      },
      required: ['targetPath'],
    },
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
    e2e_init:     'init',
    e2e_audit:    'audit',
    e2e_shadow:   'shadow',
    e2e_diff:     'diff',
    e2e_repair:   'repair',
    e2e_coverage: 'coverage',
    e2e_update:   'update',
    e2e_sentinel: 'sentinel',
    e2e_arch:     'arch',
    e2e_chaos:    'chaos',
  };
  const command = commandMap[toolName];
  if (!command) return err(`Unknown tool: ${toolName}`);

  const dryRun  = Boolean(args.dryRun);
  const traceId = args.traceId as string | undefined;

  try {
    const prNum  = typeof args.prNumber === 'number' ? args.prNumber : undefined;
    const repoSl = typeof args.repo === 'string' ? args.repo : undefined;
    await run({ command, level, chaos, predictive, targetPath, traceId, dryRun, prNumber: prNum, repo: repoSl });
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
      version: '2.0.0',
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

const HELP = `
test-end-to-end V-Infinite 2.0.0 — Autonomous QA Engine
13 agents · 11 MCP tools · Zero-Token Bypass via SHA-256 + Ollama

USAGE
  node dist/index.js <command> [targetPath] [flags]

COMMANDS
  init        Initialise le projet cible : détecte le stack, amorce le cache,
              génère la config Playwright.
              Ex: node dist/index.js init /mon/projet

  audit       Audit E2E complet : scan AST → génération tests → triage → rapport.
              Ex: node dist/index.js audit --level=2 --predictive

  shadow      Zero-prompt Reverse Testing + Shadow Personas (Frustrated / Attacker /
              Impulsive). Fonctionne sans qu'on décrive une seule fonctionnalité.
              Ex: node dist/index.js shadow --level=3 --chaos

  diff        Cible le scan sur les fichiers modifiés (git diff HEAD + staged).
              Ex: node dist/index.js diff --predictive --level=2

  repair      Active Ghostwriter pour patcher un bug confirmé par le Coroner.
              Ex: node dist/index.js repair --trace=run-1718542800000

  coverage    Carte de couverture : routes + forms vs fichiers de test existants.
              Ex: node dist/index.js coverage --detail

  update      Sync intelligent après changements de code. Protège les tests manuels.
              Ex: node dist/index.js update --dry-run

  sentinel    Audit sécurité OWASP sur une Pull Request GitHub.
              Détecte secrets, SQLi, SSRF, eval, XSS, IDOR, RCE.
              Utilise Ollama (local, 0 token) ou regex OWASP en fallback.
              Ex: node dist/index.js sentinel --pr=42
                  node dist/index.js sentinel --pr=42 --repo=owner/repo

  arch        Analyse l'architecture du code (complexité cyclomatique, couplage).
              Score 0-100. Génère .e2e-work/arch-report.md
              Ex: node dist/index.js arch /mon/projet

  chaos       Génère des specs Playwright de chaos réseau (6 scénarios par route).
              Ex: node dist/index.js chaos --port=8080

FLAGS
  --level=1         Déterministe local — AST pur, sans LLM
  --level=2         Hybride cognitif — Vision IA sur sélecteur cassé (défaut)
  --level=3         Meta-Agent Infinite — Shadow Personas + Ghostwriter + Evolver
  --chaos           Inject scénarios de faute réseau / double-submit / i18n
  --predictive      Git forensics 12 mois → hotspot ranking
  --dry-run         Affiche ce qui serait fait sans écrire de fichier (update)
  --detail          Sortie détaillée par route (coverage)
  --trace=<id>      Charge un triage spécifique par son identifiant (repair)
  --pr=<number>     Numéro de Pull Request GitHub à auditer (sentinel)
  --repo=<owner/r>  Dépôt cible owner/repo (sentinel)
  --port=<number>   Port du serveur local à tester (chaos, défaut: 3000)
  --reset-cache     Vide le cache d'empreintes SHA-256
  --mcp             Démarre en mode serveur MCP (stdin/stdout JSON-RPC)
  --version         Affiche la version

DASHBOARD
  node dist/server/start.js          → http://127.0.0.1:4321
  E2E_PORT=4444 node dist/server/start.js

MCP (.mcp.json)
  { "mcpServers": { "e2e": { "command": "node",
    "args": ["/chemin/dist/index.js", "--mcp"] } } }
`.trimStart();

async function runCli(parsed: ParsedArgs): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  if (process.argv.includes('--version') || process.argv.includes('-v')) {
    process.stdout.write('test-end-to-end V-Infinite 2.0.0\n');
    process.exit(0);
  }

  if (!parsed.command) {
    process.stdout.write(HELP);
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
    targetPath: parsed.targetPath ? resolve(parsed.targetPath) : resolve(process.cwd()),
    traceId:    parsed.traceId,
    dryRun:     parsed.dryRun,
    detail:     parsed.detail,
    prNumber:   parsed.prNumber,
    repo:       parsed.repo,
    port:       parsed.port,
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
