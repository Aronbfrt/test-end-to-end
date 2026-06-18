/**
 * sentinel.ts — Agent DevSecOps & auditeur de Pull Requests.
 *
 * Intercepte les PRs ouvertes via GitHub CLI (gh), soumet le diff
 * au LLM pour détection de failles (injections, backdoors, logique
 * cassée), puis approuve ou rejette la PR avec un rapport motivé.
 *
 * Prérequis :
 *   - GitHub CLI (gh) installé et authentifié
 *   - GITHUB_TOKEN dans l'environnement
 *
 * Usage CLI :
 *   node dist/index.js sentinel [targetPath]
 *   node dist/index.js sentinel [targetPath] --pr=42
 */

import { execSync } from 'node:child_process';
import type { RunConfig, OllamaCapability } from '../orchestrator.js';
import { notifySentinel } from '../integrations/notifier.js';
import { recordMetric } from '../utils/metricsTracker.js';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface PullRequest {
  number: number;
  title:  string;
  author: string;
  url:    string;
  repo:   string;
}

export interface SecurityFinding {
  severity:    'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';
  category:    string;
  description: string;
  file?:       string;
  line?:       number;
  snippet?:    string;
}

export interface SentinelResult {
  pr:        PullRequest;
  decision:  'APPROVE' | 'REJECT' | 'COMMENT';
  findings:  SecurityFinding[];
  summary:   string;
  riskScore: number;
}

// ── GitHub CLI helpers ────────────────────────────────────────────────────────

function ghAvailable(): boolean {
  try {
    execSync('gh --version', { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

function getOpenPRs(repo?: string): PullRequest[] {
  const repoFlag = repo ? `--repo ${repo}` : '';
  try {
    const out = execSync(
      `gh pr list ${repoFlag} --state open --json number,title,author,url --limit 20`,
      { encoding: 'utf-8', timeout: 15_000 },
    );
    const prs = JSON.parse(out) as Array<{
      number: number;
      title:  string;
      author: { login: string };
      url:    string;
    }>;
    const repoSlug = repo ?? detectRepo();
    return prs.map((p) => ({
      number: p.number,
      title:  p.title,
      author: p.author.login,
      url:    p.url,
      repo:   repoSlug,
    }));
  } catch (e) {
    console.warn(`[sentinel] gh pr list failed: ${(e as Error).message}`);
    return [];
  }
}

function getPRDiff(prNumber: number, repo?: string): string {
  const repoFlag = repo ? `--repo ${repo}` : '';
  try {
    return execSync(
      `gh pr diff ${prNumber} ${repoFlag}`,
      { encoding: 'utf-8', timeout: 30_000, maxBuffer: 5 * 1024 * 1024 },
    );
  } catch (e) {
    console.warn(`[sentinel] gh pr diff failed: ${(e as Error).message}`);
    return '';
  }
}

function approvePR(prNumber: number, body: string, repo?: string): void {
  const repoFlag = repo ? `--repo ${repo}` : '';
  execSync(
    `gh pr review ${prNumber} ${repoFlag} --approve --body ${JSON.stringify(body)}`,
    { encoding: 'utf-8', timeout: 15_000 },
  );
}

function rejectPR(prNumber: number, body: string, repo?: string): void {
  const repoFlag = repo ? `--repo ${repo}` : '';
  execSync(
    `gh pr review ${prNumber} ${repoFlag} --request-changes --body ${JSON.stringify(body)}`,
    { encoding: 'utf-8', timeout: 15_000 },
  );
}

function commentPR(prNumber: number, body: string, repo?: string): void {
  const repoFlag = repo ? `--repo ${repo}` : '';
  execSync(
    `gh pr comment ${prNumber} ${repoFlag} --body ${JSON.stringify(body)}`,
    { encoding: 'utf-8', timeout: 15_000 },
  );
}

function detectRepo(): string {
  try {
    return execSync('gh repo view --json nameWithOwner --jq .nameWithOwner', {
      encoding: 'utf-8', timeout: 5000,
    }).trim();
  } catch {
    return 'unknown/repo';
  }
}

// ── Security analysis via LLM ──────────────────────────────────────────────────

const SECURITY_SYSTEM_PROMPT = `Tu es un expert en sécurité logicielle (OWASP, CVE, supply chain attacks).
Analyse ce diff de Pull Request et détecte :
1. Injections (SQL, NoSQL, Command, LDAP, XPath)
2. Backdoors et code malveillant (exfiltration de données, reverse shells)
3. Secrets hardcodés (API keys, passwords, tokens)
4. Failles logiques (bypass d'authentification, autorisation cassée)
5. Dépendances vulnérables ajoutées
6. Élévation de privilèges
7. Vulnérabilités SSRF, XXE, deserialization
8. Typosquatting de package

Réponds en JSON strict :
{
  "riskScore": <0-100>,
  "decision": "APPROVE" | "REJECT" | "COMMENT",
  "findings": [
    {
      "severity": "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO",
      "category": "<catégorie>",
      "description": "<description précise>",
      "file": "<fichier si identifiable>",
      "snippet": "<extrait de code concerné>"
    }
  ],
  "summary": "<résumé en 2-3 phrases>"
}

APPROVE si riskScore < 30.
COMMENT si 30 ≤ riskScore < 60.
REJECT si riskScore ≥ 60 ou finding CRITICAL.`;

async function analyzeWithOllama(
  diff: string,
  ollama: OllamaCapability,
): Promise<{ decision: 'APPROVE' | 'REJECT' | 'COMMENT'; findings: SecurityFinding[]; summary: string; riskScore: number }> {
  const truncatedDiff = diff.slice(0, 8000);
  const prompt = `${SECURITY_SYSTEM_PROMPT}\n\n---DIFF---\n${truncatedDiff}`;

  const res = await fetch(`${ollama.endpoint}/api/generate`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ model: ollama.model, prompt, stream: false, format: 'json' }),
    signal:  AbortSignal.timeout(60_000),
  });

  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
  const data = await res.json() as { response?: string };
  const parsed = JSON.parse(data.response ?? '{}') as {
    riskScore?: number;
    decision?:  string;
    findings?:  SecurityFinding[];
    summary?:   string;
  };

  return {
    decision:  (['APPROVE', 'REJECT', 'COMMENT'].includes(parsed.decision ?? '') ? parsed.decision : 'COMMENT') as 'APPROVE' | 'REJECT' | 'COMMENT',
    findings:  Array.isArray(parsed.findings) ? parsed.findings : [],
    summary:   parsed.summary ?? 'Analyse indisponible',
    riskScore: typeof parsed.riskScore === 'number' ? parsed.riskScore : 50,
  };
}

function analyzeWithRegex(diff: string): {
  decision: 'APPROVE' | 'REJECT' | 'COMMENT';
  findings: SecurityFinding[];
  summary:  string;
  riskScore: number;
} {
  const findings: SecurityFinding[] = [];

  const checks: Array<{ rx: RegExp; sev: SecurityFinding['severity']; cat: string; desc: string }> = [
    { rx: /['"]([A-Za-z0-9+/]{40,})['"]/g,                          sev: 'HIGH',     cat: 'Hardcoded Secret', desc: 'Possible clé API ou token en dur dans le code' },
    { rx: /password\s*=\s*['"][^'"]{4,}['"]/gi,                     sev: 'CRITICAL', cat: 'Hardcoded Password', desc: 'Mot de passe en clair dans le code source' },
    { rx: /exec\s*\(\s*\$_(GET|POST|REQUEST)/gi,                     sev: 'CRITICAL', cat: 'Command Injection', desc: 'Exécution de commande depuis input utilisateur' },
    { rx: /eval\s*\(\s*\$_(GET|POST|REQUEST)/gi,                     sev: 'CRITICAL', cat: 'Code Injection', desc: 'eval() sur données utilisateur non filtrées' },
    { rx: /mysql_query\s*\([^)]*\$_(GET|POST)/gi,                   sev: 'CRITICAL', cat: 'SQL Injection', desc: 'Requête SQL avec input utilisateur non préparé' },
    { rx: /curl_init\s*\(\s*\$_(GET|POST)/gi,                       sev: 'HIGH',     cat: 'SSRF', desc: 'Possible SSRF via URL contrôlée par l\'utilisateur' },
    { rx: /\b(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{36,}|AKIA[A-Z0-9]{16})\b/g, sev: 'CRITICAL', cat: 'Leaked API Key', desc: 'Clé API exposée dans le diff' },
    { rx: /require\s*\(['"]\.\.\/\.\.\/\.\.\/\.\.\//g,              sev: 'MEDIUM',   cat: 'Path Traversal', desc: 'Potentielle traversée de répertoire' },
    { rx: /child_process.*exec\(/g,                                  sev: 'HIGH',     cat: 'Shell Execution', desc: 'Exécution de shell dans le code' },
  ];

  for (const check of checks) {
    check.rx.lastIndex = 0;
    if (check.rx.test(diff)) {
      findings.push({ severity: check.sev, category: check.cat, description: check.desc });
    }
  }

  const hasCritical = findings.some((f) => f.severity === 'CRITICAL');
  const hasHigh     = findings.some((f) => f.severity === 'HIGH');
  const riskScore   = hasCritical ? 90 : hasHigh ? 60 : findings.length > 0 ? 40 : 10;
  const decision    = riskScore >= 60 ? 'REJECT' : riskScore >= 30 ? 'COMMENT' : 'APPROVE';

  return {
    decision,
    findings,
    summary: findings.length === 0
      ? 'Aucune vulnérabilité évidente détectée par analyse statique regex.'
      : `${findings.length} problème(s) détecté(s) dont ${findings.filter((f) => f.severity === 'CRITICAL').length} critique(s).`,
    riskScore,
  };
}

// ── Format review body ────────────────────────────────────────────────────────

function formatReviewBody(result: Omit<SentinelResult, 'pr'>): string {
  const icon  = result.decision === 'APPROVE' ? '✅' : result.decision === 'REJECT' ? '❌' : '⚠️';
  const lines = [
    `## 🛡 Sentinel Security Review`,
    ``,
    `**Décision : ${icon} ${result.decision}** — Score de risque : ${result.riskScore}/100`,
    ``,
    result.summary,
    ``,
  ];

  if (result.findings.length > 0) {
    lines.push('### Problèmes détectés', '');
    for (const f of result.findings) {
      const sev = { CRITICAL: '🔴', HIGH: '🟠', MEDIUM: '🟡', LOW: '🔵', INFO: '⚪' }[f.severity];
      lines.push(`${sev} **[${f.severity}]** ${f.category} — ${f.description}`);
      if (f.snippet) lines.push(`\`\`\`\n${f.snippet.slice(0, 200)}\n\`\`\``);
    }
  }

  lines.push('', `---`, `*Audit automatique par [test-end-to-end](https://github.com/Aronbfrt/test-end-to-end) Sentinel*`);
  return lines.join('\n');
}

// ── Main agent entry point ─────────────────────────────────────────────────────

export async function run(
  _config: RunConfig,
  ollama: OllamaCapability | null,
  prNumber?: number,
  repo?: string,
): Promise<SentinelResult[]> {
  if (!ghAvailable()) {
    console.warn('[sentinel] GitHub CLI (gh) non trouvé — agent désactivé. Installe : https://cli.github.com');
    return [];
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.warn('[sentinel] GITHUB_TOKEN manquant dans .env — agent désactivé.');
    return [];
  }

  const results: SentinelResult[] = [];
  const prs = prNumber
    ? [{ number: prNumber, title: `PR #${prNumber}`, author: 'unknown', url: '', repo: repo ?? detectRepo() }]
    : getOpenPRs(repo);

  if (prs.length === 0) {
    console.log('[sentinel] Aucune PR ouverte à auditer.');
    return [];
  }

  console.log(`[sentinel] ${prs.length} PR(s) à auditer`);

  for (const pr of prs) {
    console.log(`[sentinel] analyse PR #${pr.number} — "${pr.title}"`);

    const diff = getPRDiff(pr.number, pr.repo);
    if (!diff.trim()) {
      console.log(`[sentinel] PR #${pr.number} — diff vide, skip`);
      continue;
    }

    let analysis: { decision: 'APPROVE' | 'REJECT' | 'COMMENT'; findings: SecurityFinding[]; summary: string; riskScore: number };
    if (ollama?.available) {
      try {
        analysis = await analyzeWithOllama(diff, ollama);
        console.log(`[sentinel] LLM analysis — risk: ${analysis.riskScore}, decision: ${analysis.decision}`);
      } catch (e) {
        console.warn(`[sentinel] LLM failed (${(e as Error).message}), fallback regex`);
        analysis = analyzeWithRegex(diff);
      }
    } else {
      analysis = analyzeWithRegex(diff);
    }

    const result: SentinelResult = { pr, ...analysis };
    const body = formatReviewBody(analysis);

    try {
      if (analysis.decision === 'APPROVE') {
        approvePR(pr.number, body, pr.repo);
        console.log(`[sentinel] PR #${pr.number} → APPROVED (risk: ${analysis.riskScore})`);
      } else if (analysis.decision === 'REJECT') {
        rejectPR(pr.number, body, pr.repo);
        console.log(`[sentinel] PR #${pr.number} → REJECTED (risk: ${analysis.riskScore})`);
      } else {
        commentPR(pr.number, body, pr.repo);
        console.log(`[sentinel] PR #${pr.number} → COMMENT (risk: ${analysis.riskScore})`);
      }
    } catch (e) {
      console.warn(`[sentinel] gh review failed: ${(e as Error).message}`);
    }

    await notifySentinel({
      prNumber:  pr.number,
      prTitle:   pr.title,
      decision:  analysis.decision === 'COMMENT' ? 'APPROVE' : analysis.decision,
      summary:   analysis.summary,
      repo:      pr.repo,
    }).catch(() => { /* non-fatal */ });

    await recordMetric('sentinel_reviews', 1).catch(() => { /* non-fatal */ });
    results.push(result);
  }

  return results;
}
