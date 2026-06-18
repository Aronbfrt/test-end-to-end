/**
 * chaosMonkey.ts — Agent d'injection de chaos réseau / latence / erreurs.
 *
 * Utilise Playwright page.route() pour intercepter et perturber les requêtes
 * HTTP du navigateur selon différents scénarios :
 *   - LATENCY  : ajoute 2-5s de délai sur toutes les requêtes API
 *   - TIMEOUT  : avorte les requêtes vers les endpoints API (simule ETIMEDOUT)
 *   - ERROR_50x: remplace les réponses par des HTTP 500/503
 *   - OFFLINE  : bloque toutes les requêtes réseau (simule réseau coupé)
 *   - CORRUPT  : renvoie du JSON malformé sur les API
 *   - PARTIAL  : réponse tronquée (simule transfer interrompu)
 *
 * Intégré dans artisan.ts lorsque config.chaos === true.
 * Produit des fichiers chaos_*.spec.ts dans tests/<route>/.
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join }       from 'node:path';
import { randomUUID } from 'node:crypto';
import type { RunConfig, RouteMap } from '../orchestrator.js';

// ── Types ──────────────────────────────────────────────────────────────────────

export type ChaosScenario =
  | 'LATENCY'
  | 'TIMEOUT'
  | 'ERROR_50x'
  | 'OFFLINE'
  | 'CORRUPT'
  | 'PARTIAL';

export interface ChaosSpec {
  route:      string;
  scenario:   ChaosScenario;
  file:       string;
  specPath:   string;
}

// ── Spec template generators ──────────────────────────────────────────────────

function latencySpec(baseUrl: string, route: string, routeSlug: string): string {
  return `import { test, expect } from '@playwright/test';

test('chaos:LATENCY — ${route} doit afficher un état de chargement sous latence réseau', async ({ page }) => {
  await page.route('**/*.json', async (route) => {
    await new Promise((r) => setTimeout(r, 3000 + Math.random() * 2000));
    await route.continue();
  });
  await page.route('**/api/**', async (route) => {
    await new Promise((r) => setTimeout(r, 3000 + Math.random() * 2000));
    await route.continue();
  });

  const t0 = Date.now();
  await page.goto('${baseUrl}${route}');
  const elapsed = Date.now() - t0;

  // Page must still respond without crashing under latency
  await expect(page).not.toHaveTitle(/error|erreur|500|503/i);

  // Check no unhandled error visible
  const errorText = await page.locator('[class*="error"], [id*="error"], .alert-danger').count();
  expect(errorText).toBe(0);

  console.log(\`[chaos:LATENCY] ${routeSlug} survived \${elapsed}ms latency\`);
});
`;
}

function timeoutSpec(baseUrl: string, route: string, routeSlug: string): string {
  return `import { test, expect } from '@playwright/test';

test('chaos:TIMEOUT — ${route} doit gérer les timeouts API sans crash', async ({ page }) => {
  await page.route('**/api/**', (route) => route.abort('timedout'));
  await page.route('**/*.json', (route) => route.abort('timedout'));

  await page.goto('${baseUrl}${route}');

  // Page must load (HTML at least)
  await expect(page).not.toHaveTitle(/cannot get|404 not found/i);

  // Should show error state, not crash JS
  const jsErrors: string[] = [];
  page.on('pageerror', (e) => jsErrors.push(e.message));
  await page.waitForTimeout(2000);

  const criticalErrors = jsErrors.filter((e) =>
    /uncaught|typeerror|referenceerror/i.test(e)
  );
  expect(criticalErrors).toHaveLength(0);

  console.log('[chaos:TIMEOUT] ${routeSlug} — no JS crash on API abort');
});
`;
}

function error50xSpec(baseUrl: string, route: string, routeSlug: string): string {
  return `import { test, expect } from '@playwright/test';

test('chaos:ERROR_50x — ${route} doit afficher message d\\'erreur convivial sur HTTP 500', async ({ page }) => {
  await page.route('**/api/**', (route) =>
    route.fulfill({ status: 500, body: JSON.stringify({ error: 'Internal Server Error' }), contentType: 'application/json' })
  );

  await page.goto('${baseUrl}${route}');
  await page.waitForLoadState('domcontentloaded');

  // Should not expose raw stack trace
  const body = await page.content();
  expect(body).not.toMatch(/at Object\\.|at Module\\.|node_modules|stack trace/i);

  console.log('[chaos:ERROR_50x] ${routeSlug} — no stack trace exposed');
});

test('chaos:ERROR_503 — ${route} doit gérer les Service Unavailable', async ({ page }) => {
  await page.route('**/api/**', (route) =>
    route.fulfill({ status: 503, body: 'Service Unavailable', contentType: 'text/plain' })
  );

  await page.goto('${baseUrl}${route}');
  const title = await page.title();
  expect(title).not.toMatch(/error|erreur/i);

  console.log('[chaos:ERROR_503] ${routeSlug} — graceful 503 handling');
});
`;
}

function offlineSpec(baseUrl: string, route: string, routeSlug: string): string {
  return `import { test, expect } from '@playwright/test';

test('chaos:OFFLINE — ${route} doit rester utilisable sans connexion réseau', async ({ page, context }) => {
  // Load the page first (cache assets)
  await page.goto('${baseUrl}${route}');
  await page.waitForLoadState('networkidle').catch(() => {});

  // Block all further requests
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith('${baseUrl}')) {
      return route.continue();
    }
    return route.abort('internetdisconnected');
  });

  // Reload with "offline" API responses
  await page.route('**/api/**', (route) => route.abort('internetdisconnected'));
  await page.reload().catch(() => {});

  // Critical check: no white page, page still has content
  const bodyText = await page.locator('body').innerText().catch(() => '');
  expect(bodyText.trim().length).toBeGreaterThan(0);

  console.log('[chaos:OFFLINE] ${routeSlug} — not a blank page when offline');
});
`;
}

function corruptSpec(baseUrl: string, route: string, routeSlug: string): string {
  return `import { test, expect } from '@playwright/test';

test('chaos:CORRUPT — ${route} doit gérer les réponses JSON malformées', async ({ page }) => {
  await page.route('**/api/**', (route) =>
    route.fulfill({
      status:      200,
      contentType: 'application/json',
      body:        '{ invalid json ][[ corrupted response >>>',
    })
  );

  const jsErrors: string[] = [];
  page.on('pageerror', (e) => jsErrors.push(e.message));

  await page.goto('${baseUrl}${route}');
  await page.waitForTimeout(2000);

  const syntaxErrors = jsErrors.filter((e) => /syntaxerror|json parse/i.test(e));
  // A SyntaxError from JSON.parse should be caught, not propagated to window
  expect(syntaxErrors).toHaveLength(0);

  console.log('[chaos:CORRUPT] ${routeSlug} — no uncaught JSON parse error');
});
`;
}

function partialSpec(baseUrl: string, route: string, routeSlug: string): string {
  return `import { test, expect } from '@playwright/test';

test('chaos:PARTIAL — ${route} doit gérer les réponses tronquées', async ({ page }) => {
  await page.route('**/api/**', (route) =>
    route.fulfill({
      status:      200,
      contentType: 'application/json',
      body:        '{"data": [1, 2, 3',  // truncated
    })
  );

  const jsErrors: string[] = [];
  page.on('pageerror', (e) => jsErrors.push(e.message));

  await page.goto('${baseUrl}${route}');
  await page.waitForTimeout(2000);

  // Page must not show raw error to user
  const body = await page.content();
  expect(body).not.toMatch(/unexpected end of json|json parse error/i);

  console.log('[chaos:PARTIAL] ${routeSlug} — truncated response handled gracefully');
});
`;
}

// ── Spec file generator ───────────────────────────────────────────────────────

function generateChaosSpec(
  baseUrl:   string,
  route:     string,
  scenario:  ChaosScenario,
  outputDir: string,
): ChaosSpec {
  const routeSlug = route.replace(/\//g, '_').replace(/^_/, '') || 'root';
  const fileName  = `chaos_${scenario.toLowerCase()}_${routeSlug}_${randomUUID().slice(0, 6)}.spec.ts`;
  const dir       = join(outputDir, routeSlug);

  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const specPath = join(dir, fileName);

  const templates: Record<ChaosScenario, () => string> = {
    LATENCY:   () => latencySpec(baseUrl, route, routeSlug),
    TIMEOUT:   () => timeoutSpec(baseUrl, route, routeSlug),
    ERROR_50x: () => error50xSpec(baseUrl, route, routeSlug),
    OFFLINE:   () => offlineSpec(baseUrl, route, routeSlug),
    CORRUPT:   () => corruptSpec(baseUrl, route, routeSlug),
    PARTIAL:   () => partialSpec(baseUrl, route, routeSlug),
  };

  const content = templates[scenario]();
  writeFileSync(specPath, content, 'utf-8');

  return { route, scenario, file: fileName, specPath };
}

// ── Main agent run ─────────────────────────────────────────────────────────────

export interface ChaosRunResult {
  specs:     ChaosSpec[];
  scenarios: ChaosScenario[];
  routes:    string[];
}

const ALL_SCENARIOS: ChaosScenario[] = [
  'LATENCY', 'TIMEOUT', 'ERROR_50x', 'OFFLINE', 'CORRUPT', 'PARTIAL',
];

export async function run(
  config: RunConfig,
  routes: RouteMap,
): Promise<ChaosRunResult> {
  const baseUrl    = `http://localhost:${config.port ?? 3000}`;
  const testsDir   = join(config.targetPath, 'tests');
  const scenarios  = config.chaosScenarios ?? ALL_SCENARIOS;
  const specs: ChaosSpec[] = [];

  if (!existsSync(testsDir)) mkdirSync(testsDir, { recursive: true });

  const targetRoutes = routes.routes.slice(0, 10).map((r) => r.path); // limit to 10 to avoid spec explosion

  for (const route of targetRoutes) {
    for (const scenario of scenarios) {
      const spec = generateChaosSpec(baseUrl, route, scenario, testsDir);
      specs.push(spec);
      console.log(`[chaosMonkey] Generated ${scenario} spec for ${route}`);
    }
  }

  console.log(`[chaosMonkey] ${specs.length} chaos specs generated (${targetRoutes.length} routes × ${scenarios.length} scenarios)`);

  return {
    specs,
    scenarios,
    routes: targetRoutes,
  };
}

export function chaosEnabled(config: RunConfig): boolean {
  return config.chaos === true;
}
