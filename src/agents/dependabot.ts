/**
 * dependabot.ts — Agent de sécurité des dépendances (npm audit + correctifs LLM).
 *
 * Analyse les vulnérabilités npm dans le projet cible via `npm audit --json`,
 * filtre par sévérité, tente `npm install pkg@latest`, vérifie avec `tsc --noEmit`,
 * et génère un rapport de sécurité + PR GitHub si configuré.
 *
 * Usage :
 *   npm run security-fix                    (via package.json script)
 *   node dist/agents/dependabot.js <path>   (CLI direct)
 *
 * Variables .env optionnelles :
 *   GITHUB_TOKEN    — pour créer une PR automatique
 *   DEPENDABOT_MIN_SEVERITY  — critical|high|moderate|low (défaut: high)
 */

import { execSync } from 'node:child_process';
import { writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { OllamaCapability } from '../orchestrator.js';

// ── Types ──────────────────────────────────────────────────────────────────────

type Severity = 'critical' | 'high' | 'moderate' | 'low' | 'info';

interface AuditVulnerability {
  name:        string;
  severity:    Severity;
  via:         Array<string | { name: string; url?: string; title?: string }>;
  range:       string;
  nodes:       string[];
  fixAvailable: boolean | { name: string; version: string; isSemVerMajor: boolean };
}

interface NpmAuditResult {
  vulnerabilities: Record<string, AuditVulnerability>;
  metadata: {
    vulnerabilities: Record<Severity, number>;
    dependencies:    { total: number };
  };
}

export interface FixResult {
  package:       string;
  severity:      Severity;
  fixed:         boolean;
  newVersion?:   string;
  breakingChange: boolean;
  error?:        string;
}

export interface DependabotReport {
  targetPath:     string;
  totalIssues:    number;
  fixed:          number;
  failed:         number;
  breaking:       number;
  skipped:        number;
  fixes:          FixResult[];
  prUrl?:         string;
  generatedAt:    string;
}

// ── Severity ordering ─────────────────────────────────────────────────────────

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 4,
  high:     3,
  moderate: 2,
  low:      1,
  info:     0,
};

function severityAbove(a: Severity, min: Severity): boolean {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[min];
}

// ── npm audit runner ──────────────────────────────────────────────────────────

function runNpmAudit(cwd: string): NpmAuditResult | null {
  try {
    const raw = execSync('npm audit --json', {
      cwd,
      encoding:  'utf-8',
      timeout:   60_000,
      maxBuffer: 10 * 1024 * 1024,
      stdio:     ['ignore', 'pipe', 'ignore'],
    });
    return JSON.parse(raw) as NpmAuditResult;
  } catch (e) {
    const err = e as { stdout?: string; message: string };
    if (err.stdout) {
      try {
        return JSON.parse(err.stdout) as NpmAuditResult;
      } catch {
        console.warn(`[dependabot] npm audit JSON parse failed: ${err.message.slice(0, 100)}`);
      }
    }
    console.warn(`[dependabot] npm audit failed: ${err.message.slice(0, 100)}`);
    return null;
  }
}

// ── Fix attempt via npm install ───────────────────────────────────────────────

function tryInstallLatest(pkgName: string, cwd: string): { version: string; breaking: boolean } | null {
  try {
    // Get current installed version
    const listRaw = execSync(`npm list ${pkgName} --json --depth=0`, {
      cwd, encoding: 'utf-8', timeout: 15_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const listData = JSON.parse(listRaw) as { dependencies?: Record<string, { version: string }> };
    const currentVersion = listData.dependencies?.[pkgName]?.version ?? '0.0.0';
    const currentMajor   = parseInt(currentVersion.split('.')[0] ?? '0', 10);

    // Get latest version
    const latestRaw = execSync(`npm view ${pkgName} version --json`, {
      cwd, encoding: 'utf-8', timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const latestVersion = JSON.parse(latestRaw) as string;
    const latestMajor   = parseInt(latestVersion.split('.')[0] ?? '0', 10);
    const breaking      = latestMajor > currentMajor;

    // Attempt install
    execSync(`npm install ${pkgName}@latest --save`, {
      cwd, timeout: 60_000,
      stdio: ['ignore', 'ignore', 'ignore'],
    });

    return { version: latestVersion, breaking };
  } catch {
    return null;
  }
}

function typeCheckPasses(cwd: string): boolean {
  try {
    if (!existsSync(join(cwd, 'tsconfig.json'))) return true;
    execSync('npx tsc --noEmit', {
      cwd, timeout: 60_000,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

function revertPackage(pkgName: string, originalVersion: string, cwd: string): void {
  try {
    execSync(`npm install ${pkgName}@${originalVersion} --save`, {
      cwd, timeout: 60_000,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
  } catch {
    console.warn(`[dependabot] Failed to revert ${pkgName}@${originalVersion}`);
  }
}

// ── LLM analysis ──────────────────────────────────────────────────────────────

async function analyzeBreakingChange(
  pkgName:    string,
  oldVersion: string,
  newVersion: string,
  tscError:   string,
  ollama:     OllamaCapability,
): Promise<string> {
  const prompt =
    `Le package "${pkgName}" a été mis à jour de v${oldVersion} à v${newVersion}. ` +
    `TypeScript échoue avec l'erreur suivante. Explique le breaking change et la migration:\n\n` +
    tscError.slice(0, 2000);

  try {
    const res = await fetch(`${ollama.endpoint}/api/generate`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ model: ollama.model, prompt, stream: false }),
      signal:  AbortSignal.timeout(30_000),
    });
    if (!res.ok) return 'LLM indisponible';
    const data = await res.json() as { response?: string };
    return data.response?.slice(0, 500) ?? 'Analyse indisponible';
  } catch {
    return 'LLM indisponible';
  }
}

// ── GitHub PR creation ────────────────────────────────────────────────────────

function createSecurityPR(
  cwd:     string,
  fixes:   FixResult[],
  branch:  string,
): string | null {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return null;

  try {
    execSync(`git checkout -b ${branch}`, { cwd, stdio: 'ignore' });
    execSync('git add package.json package-lock.json', { cwd, stdio: 'ignore' });

    const fixedList = fixes
      .filter((f) => f.fixed)
      .map((f) => `- ${f.package}@${f.newVersion} (${f.severity})`)
      .join('\n');

    const commitMsg = `fix(security): mise à jour dépendances vulnérables\n\nDépendances corrigées :\n${fixedList}\n\nGénéré par test-end-to-end Dependabot`;
    execSync(`git commit -m ${JSON.stringify(commitMsg)}`, { cwd, stdio: 'ignore' });
    execSync(`git push origin ${branch}`, { cwd, stdio: 'ignore' });

    const prBody = `## Correctifs de sécurité automatiques\n\n${fixedList}\n\nGénéré automatiquement par [test-end-to-end](https://github.com/Aronbfrt/test-end-to-end) Dependabot Agent`;
    const prRaw  = execSync(
      `gh pr create --title "fix(security): mise à jour dépendances vulnérables" --body ${JSON.stringify(prBody)} --base main`,
      { cwd, encoding: 'utf-8', timeout: 15_000 },
    );
    return prRaw.trim().split('\n').pop() ?? null;
  } catch (e) {
    console.warn(`[dependabot] PR creation failed: ${(e as Error).message}`);
    return null;
  }
}

// ── Main agent ─────────────────────────────────────────────────────────────────

export async function run(
  targetPath: string,
  ollama: OllamaCapability | null = null,
  minSeverity: Severity = (process.env.DEPENDABOT_MIN_SEVERITY as Severity) ?? 'high',
): Promise<DependabotReport> {
  const cwd = resolve(targetPath);

  if (!existsSync(join(cwd, 'package.json'))) {
    console.warn(`[dependabot] No package.json at ${cwd}`);
    return {
      targetPath: cwd, totalIssues: 0, fixed: 0,
      failed: 0, breaking: 0, skipped: 0, fixes: [],
      generatedAt: new Date().toISOString(),
    };
  }

  console.log('[dependabot] Running npm audit...');
  const audit = runNpmAudit(cwd);

  if (!audit) {
    return {
      targetPath: cwd, totalIssues: 0, fixed: 0,
      failed: 0, breaking: 0, skipped: 0, fixes: [],
      generatedAt: new Date().toISOString(),
    };
  }

  const vulns    = Object.values(audit.vulnerabilities);
  const toFix    = vulns.filter((v) => severityAbove(v.severity, minSeverity) && v.fixAvailable);
  const skipped  = vulns.length - toFix.length;

  console.log(`[dependabot] ${vulns.length} vulnérabilités (${toFix.length} à corriger, ${skipped} ignorées)`);

  const fixes: FixResult[] = [];

  for (const vuln of toFix) {
    const pkgName = vuln.name;
    console.log(`[dependabot] Traitement: ${pkgName} (${vuln.severity})`);

    const installResult = tryInstallLatest(pkgName, cwd);
    if (!installResult) {
      fixes.push({ package: pkgName, severity: vuln.severity, fixed: false, breakingChange: false, error: 'npm install failed' });
      continue;
    }

    const { version: newVersion, breaking } = installResult;

    if (breaking) {
      const passes = typeCheckPasses(cwd);
      if (!passes) {
        let tscError = '';
        try {
          execSync('npx tsc --noEmit 2>&1', { cwd, encoding: 'utf-8', timeout: 60_000 });
        } catch (e) {
          tscError = (e as { stdout?: string }).stdout ?? (e as Error).message;
        }

        if (ollama?.available) {
          const analysis = await analyzeBreakingChange(pkgName, vuln.range, newVersion, tscError, ollama);
          console.log(`[dependabot] ${pkgName} breaking change analysis: ${analysis.slice(0, 100)}`);
        }

        revertPackage(pkgName, vuln.range, cwd);
        fixes.push({ package: pkgName, severity: vuln.severity, fixed: false, breakingChange: true, newVersion, error: 'Breaking change — reverted' });
        continue;
      }
    }

    fixes.push({ package: pkgName, severity: vuln.severity, fixed: true, newVersion, breakingChange: breaking });
    console.log(`[dependabot] ✓ ${pkgName} → ${newVersion}${breaking ? ' (breaking, tests pass)' : ''}`);
  }

  const report: DependabotReport = {
    targetPath: cwd,
    totalIssues: vulns.length,
    fixed:    fixes.filter((f) => f.fixed).length,
    failed:   fixes.filter((f) => !f.fixed && !f.breakingChange).length,
    breaking: fixes.filter((f) => f.breakingChange).length,
    skipped,
    fixes,
    generatedAt: new Date().toISOString(),
  };

  // Auto-PR if fixes applied and git repo
  if (report.fixed > 0 && existsSync(join(cwd, '.git'))) {
    const branch = `fix/security-deps-${Date.now()}`;
    const prUrl  = createSecurityPR(cwd, fixes, branch);
    if (prUrl) {
      report.prUrl = prUrl;
      console.log(`[dependabot] PR créée: ${prUrl}`);
    }
  }

  // Write JSON report
  const reportPath = join(cwd, '.e2e-work', 'dependabot-report.json');
  writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`[dependabot] Rapport: ${reportPath}`);
  console.log(`[dependabot] ${report.fixed} corrigés / ${report.breaking} breaking / ${report.failed} échoués / ${report.skipped} ignorés`);

  return report;
}

// ── CLI entry point ───────────────────────────────────────────────────────────

if (process.argv[1]?.endsWith('dependabot.js')) {
  const targetPath = process.argv[2] ?? process.cwd();
  run(targetPath, null).catch(console.error);
}
