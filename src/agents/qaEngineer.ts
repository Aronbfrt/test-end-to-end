/**
 * qaEngineer.ts — Agent de génération de tests de régression.
 *
 * Déclenché par l'orchestrateur après chaque patch Ghostwriter réussi.
 * Analyse le triage Coroner + le contexte du crash pour écrire un test
 * Playwright ciblant précisément le comportement corrigé.
 *
 * But : sanctuariser le fix et bloquer toute régression future.
 *
 * Fichier généré :
 *   tests/<route>/regression_<traceId>.spec.ts
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join }  from 'node:path';
import type { RunConfig, OllamaCapability } from '../orchestrator.js';
import type { TriageResult }  from '../agents/coroner.js';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface QaTask {
  traceId:    string;
  route:      string;
  triage:     TriageResult;
  patchedFiles: string[];
  targetPath: string;
}

// ── Test generators par verdict ────────────────────────────────────────────────

function generateSelectorDriftTest(
  route: string,
  traceId: string,
  brokenSelector: string | undefined,
  suggestedSelector: string | undefined,
  baseUrl: string,
): string {
  const selector = suggestedSelector ?? brokenSelector ?? '[data-testid]';
  const testName = `[regression-${traceId}] selector présent après refactoring`;
  return `import { test, expect } from '@playwright/test';

// Régression générée par QA Engineer — ${new Date().toISOString()}
// Verdict : SELECTOR_DRIFT — sélecteur manquant après refactoring DOM
// TraceID : ${traceId}

test(${JSON.stringify(testName)}, async ({ page }) => {
  await page.goto(${JSON.stringify(baseUrl + route)});

  // Vérifie que la page charge correctement
  await expect(page).not.toHaveTitle(/404|error|not found/i);

  // Vérifie que le sélecteur corrigé est présent
  const el = page.locator(${JSON.stringify(selector)});
  await expect(el).toBeVisible({ timeout: 5000 });
});
`;
}

function generateAssertionBugTest(
  route: string,
  traceId: string,
  reasoning: string,
  baseUrl: string,
): string {
  const testName = `[regression-${traceId}] assertion correcte après fix`;
  return `import { test, expect } from '@playwright/test';

// Régression générée par QA Engineer — ${new Date().toISOString()}
// Verdict : ASSERTION_BUG — attente de test incorrecte
// TraceID : ${traceId}

test(${JSON.stringify(testName)}, async ({ page }) => {
  await page.goto(${JSON.stringify(baseUrl + route)});

  // La page doit répondre avec un status 2xx/3xx
  const res = await page.goto(${JSON.stringify(baseUrl + route)});
  expect(res?.status()).toBeLessThan(400);

  // La page ne doit pas contenir de message d'erreur système
  const body = await page.textContent('body') ?? '';
  expect(body).not.toMatch(/internal server error|exception|stack trace/i);
});
// Contexte original : ${reasoning.slice(0, 120)}
`;
}

function generateLayoutChangeTest(
  route: string,
  traceId: string,
  baseUrl: string,
): string {
  const testName = `[regression-${traceId}] layout stable après fix`;
  return `import { test, expect } from '@playwright/test';

// Régression générée par QA Engineer — ${new Date().toISOString()}
// Verdict : LAYOUT_CHANGE — changement visuel majeur détecté
// TraceID : ${traceId}

test(${JSON.stringify(testName)}, async ({ page }) => {
  await page.goto(${JSON.stringify(baseUrl + route)});

  // La page doit charger sans erreur
  await expect(page).not.toHaveTitle(/404|error/i);

  // Snapshot visuel de référence (baseline créée au premier run)
  await expect(page).toHaveScreenshot(\`regression-${traceId}.png\`, {
    maxDiffPixelRatio: 0.02,
    animations: 'disabled',
  });
});
`;
}

function generateHttp5xxTest(
  route: string,
  traceId: string,
  statusCode: number,
  baseUrl: string,
): string {
  const testName = `[regression-${traceId}] HTTP ${statusCode} corrigé sur ${route}`;
  return `import { test, expect } from '@playwright/test';

// Régression générée par QA Engineer — ${new Date().toISOString()}
// Verdict : HTTP_${statusCode} — serveur en erreur
// TraceID : ${traceId}

test(${JSON.stringify(testName)}, async ({ page }) => {
  // La route ne doit plus retourner HTTP ${statusCode}
  const response = await page.goto(${JSON.stringify(baseUrl + route)});
  expect(response?.status()).not.toBe(${statusCode});
  expect(response?.status()).toBeLessThan(500);

  // La page ne doit pas afficher de stack trace
  const body = await page.textContent('body') ?? '';
  expect(body).not.toMatch(/error|exception|traceback|stack/i);
});
`;
}

function generateGenericRegressionTest(
  route: string,
  traceId: string,
  reasoning: string,
  baseUrl: string,
): string {
  const testName = `[regression-${traceId}] comportement stable sur ${route}`;
  return `import { test, expect } from '@playwright/test';

// Régression générée par QA Engineer — ${new Date().toISOString()}
// TraceID : ${traceId}

test(${JSON.stringify(testName)}, async ({ page }) => {
  const response = await page.goto(${JSON.stringify(baseUrl + route)});

  // Réponse HTTP valide
  expect(response?.status()).toBeLessThan(500);

  // Pas de page d'erreur
  await expect(page).not.toHaveTitle(/404|500|error|not found/i);

  const body = await page.textContent('body') ?? '';
  expect(body.length).toBeGreaterThan(0);
});
// Contexte : ${reasoning.slice(0, 120)}
`;
}

// ── LLM-enhanced test (Ollama) ─────────────────────────────────────────────────

async function generateWithLlm(
  task: QaTask,
  ollama: OllamaCapability,
  baseUrl: string,
): Promise<string | null> {
  const prompt =
    `Tu es un expert en tests Playwright. Génère un test de régression TypeScript complet pour empêcher la réapparition d'un bug.\n\n` +
    `Route : ${task.route}\n` +
    `Verdict : ${task.triage.verdict}\n` +
    `Diagnostic : ${task.triage.reasoning}\n` +
    `Fichiers patchés : ${task.patchedFiles.join(', ')}\n` +
    `Base URL : ${baseUrl}\n\n` +
    `Contraintes :\n` +
    `- Utilise @playwright/test uniquement\n` +
    `- TraceID dans le nom du test : regression-${task.traceId}\n` +
    `- Test fonctionnel précis ciblant le bug exact\n` +
    `- Import unique en tête de fichier\n` +
    `- Pas de commentaires superflus\n\n` +
    `Réponds avec uniquement le code TypeScript du fichier spec, sans balises markdown.`;

  try {
    const res = await fetch(`${ollama.endpoint}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: ollama.model, prompt, stream: false }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { response?: string };
    const code = data.response?.trim() ?? '';
    if (code.includes('import') && code.includes('test(')) return code;
    return null;
  } catch {
    return null;
  }
}

// ── Route → test dir ──────────────────────────────────────────────────────────

function routeToDir(route: string, targetPath: string): string {
  const clean = route.replace(/^\//, '').replace(/\//g, '_').replace(/[^a-zA-Z0-9_-]/g, '') || 'root';
  return join(targetPath, 'tests', clean);
}

// ── Main agent entry point ─────────────────────────────────────────────────────

export async function generateRegressionTest(
  task: QaTask,
  _config: RunConfig,
  ollama: OllamaCapability | null,
): Promise<string | null> {
  const baseUrl   = process.env.TEST_BASE_URL ?? 'http://localhost:3000';
  const outDir    = routeToDir(task.route, task.targetPath);
  const outPath   = join(outDir, `regression_${task.traceId}.spec.ts`);

  // Skip si le fichier existe déjà (protection manuelle)
  if (existsSync(outPath)) {
    console.log(`[qaEngineer] test régression existant préservé: ${outPath}`);
    return outPath;
  }

  let content: string | null = null;

  // Tente Ollama d'abord pour un test sur mesure
  if (ollama?.available) {
    content = await generateWithLlm(task, ollama, baseUrl);
    if (content) {
      console.log(`[qaEngineer] test généré via LLM (${ollama.model})`);
    }
  }

  // Fallback template basé sur le verdict
  if (!content) {
    const { verdict, bugReport, reasoning } = task.triage;
    const statusCode = bugReport?.statusCode ?? 0;
    const brokenSel  = bugReport?.htmlSnippet
      ? extractSelectorFromSnippet(bugReport.htmlSnippet)
      : undefined;
    const suggestedSel = (task.triage as unknown as Record<string, unknown>)['suggestedSelector'] as string | undefined;

    switch (verdict) {
      case 'SELECTOR_DRIFT':
        content = generateSelectorDriftTest(task.route, task.traceId, brokenSel, suggestedSel, baseUrl);
        break;
      case 'ASSERTION_BUG':
        content = generateAssertionBugTest(task.route, task.traceId, reasoning, baseUrl);
        break;
      case 'LAYOUT_CHANGE':
        content = generateLayoutChangeTest(task.route, task.traceId, baseUrl);
        break;
      default:
        if (statusCode >= 500) {
          content = generateHttp5xxTest(task.route, task.traceId, statusCode, baseUrl);
        } else {
          content = generateGenericRegressionTest(task.route, task.traceId, reasoning, baseUrl);
        }
    }
    console.log(`[qaEngineer] test généré via template (verdict: ${verdict})`);
  }

  if (!content) {
    console.warn(`[qaEngineer] impossible de générer le test pour ${task.traceId}`);
    return null;
  }

  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  writeFileSync(outPath, content, 'utf-8');
  console.log(`[qaEngineer] test régression écrit → ${outPath.replace(task.targetPath, '.')}`);
  return outPath;
}

// ── Helper ────────────────────────────────────────────────────────────────────

function extractSelectorFromSnippet(html: string): string | undefined {
  const idMatch    = html.match(/id=["']([^"']+)["']/);
  if (idMatch?.[1]) return `#${idMatch[1]}`;
  const classMatch = html.match(/class=["']([^"']+)["']/);
  if (classMatch?.[1]) return `.${classMatch[1].trim().split(/\s+/)[0]}`;
  const tagMatch   = html.match(/<([a-zA-Z][a-zA-Z0-9]*)/);
  return tagMatch?.[1] ? tagMatch[1].toLowerCase() : undefined;
}

// ── Orchestrator-compatible run() ─────────────────────────────────────────────

export async function run(
  task: QaTask,
  config: RunConfig,
  ollama: OllamaCapability | null,
): Promise<void> {
  await generateRegressionTest(task, config, ollama);
}
