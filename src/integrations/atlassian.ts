/**
 * atlassian.ts — Intégration Jira + Xray (hub Enterprise QA).
 *
 * Au crash : ouvre un ticket Bug dans Jira + un Test Run Échoué dans Xray.
 * À la résolution : ferme le ticket Jira avec la PR du correctif.
 *
 * Variables requises dans .env :
 *   JIRA_URL          https://monprojet.atlassian.net
 *   JIRA_TOKEN        token Atlassian (Basic Auth email:token en base64)
 *   JIRA_USER_EMAIL   email du compte Atlassian (pour Basic Auth)
 *   JIRA_PROJECT_KEY  QA (clé du projet Jira)
 */

// ── Config ────────────────────────────────────────────────────────────────────

interface JiraConfig {
  url:         string;
  token:       string;
  userEmail:   string;
  projectKey:  string;
}

function getConfig(): JiraConfig | null {
  const url        = process.env.JIRA_URL?.replace(/\/$/, '');
  const token      = process.env.JIRA_TOKEN;
  const userEmail  = process.env.JIRA_USER_EMAIL ?? process.env.JIRA_EMAIL ?? '';
  const projectKey = process.env.JIRA_PROJECT_KEY ?? 'QA';

  if (!url || !token) {
    return null;
  }
  return { url, token, projectKey, userEmail };
}

function authHeader(cfg: JiraConfig): string {
  const creds = Buffer.from(`${cfg.userEmail}:${cfg.token}`).toString('base64');
  return `Basic ${creds}`;
}

// ── Jira REST API helpers ─────────────────────────────────────────────────────

async function jiraFetch<T>(
  cfg: JiraConfig,
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${cfg.url}/rest/api/3${path}`, {
    ...options,
    headers: {
      'Authorization':  authHeader(cfg),
      'Content-Type':   'application/json',
      'Accept':         'application/json',
      ...(options.headers ?? {}),
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Jira API ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

// ── Create Jira Bug ticket ────────────────────────────────────────────────────

export interface CrashInfo {
  traceId:    string;
  route:      string;
  verdict:    string;
  confidence: number;
  reasoning:  string;
  targetPath: string;
}

export interface JiraTicket {
  id:   string;
  key:  string;
  url:  string;
}

export async function createBugTicket(crash: CrashInfo): Promise<JiraTicket | null> {
  const cfg = getConfig();
  if (!cfg) {
    console.log('[atlassian] JIRA_URL/JIRA_TOKEN manquants — ticket non créé');
    return null;
  }

  try {
    const priority = crash.confidence > 0.8 ? 'Critical'
      : crash.confidence > 0.5 ? 'High'
      : 'Medium';

    const body = {
      fields: {
        project:     { key: cfg.projectKey },
        summary:     `[E2E] ${crash.verdict} sur ${crash.route} — TraceID: ${crash.traceId}`,
        description: {
          type:    'doc',
          version: 1,
          content: [{
            type:    'paragraph',
            content: [{
              type: 'text',
              text: [
                `Route: ${crash.route}`,
                `Verdict: ${crash.verdict}`,
                `Confiance: ${(crash.confidence * 100).toFixed(0)}%`,
                ``,
                `Diagnostic: ${crash.reasoning}`,
                ``,
                `TraceID: ${crash.traceId}`,
                `Projet: ${crash.targetPath}`,
              ].join('\n'),
            }],
          }],
        },
        issuetype: { name: 'Bug' },
        priority:  { name: priority },
        labels:    ['e2e-autonomous', 'test-end-to-end', crash.verdict.toLowerCase()],
      },
    };

    const result = await jiraFetch<{ id: string; key: string; self: string }>(
      cfg, '/issue', { method: 'POST', body: JSON.stringify(body) },
    );

    const url = `${cfg.url}/browse/${result.key}`;
    console.log(`[atlassian] Bug créé → ${url}`);
    return { id: result.id, key: result.key, url };
  } catch (e) {
    console.warn(`[atlassian] createBugTicket: ${(e as Error).message}`);
    return null;
  }
}

// ── Close Jira ticket on patch ────────────────────────────────────────────────

export async function closeTicket(
  ticketKey: string,
  prUrl?: string,
): Promise<boolean> {
  const cfg = getConfig();
  if (!cfg) return false;

  try {
    // Get available transitions
    const { transitions } = await jiraFetch<{ transitions: Array<{ id: string; name: string }> }>(
      cfg, `/issue/${ticketKey}/transitions`,
    );

    const doneTransition = transitions.find((t) =>
      /done|closed|resolved|fixed/i.test(t.name),
    );

    if (!doneTransition) {
      console.warn(`[atlassian] Aucune transition "Done" trouvée pour ${ticketKey}`);
      return false;
    }

    await jiraFetch<unknown>(cfg, `/issue/${ticketKey}/transitions`, {
      method: 'POST',
      body:   JSON.stringify({ transition: { id: doneTransition.id } }),
    });

    if (prUrl) {
      await jiraFetch<unknown>(cfg, `/issue/${ticketKey}/comment`, {
        method: 'POST',
        body:   JSON.stringify({
          body: {
            type: 'doc', version: 1,
            content: [{
              type:    'paragraph',
              content: [{ type: 'text', text: `✅ Correctif déployé par Ghostwriter. PR: ${prUrl}` }],
            }],
          },
        }),
      });
    }

    console.log(`[atlassian] Ticket ${ticketKey} fermé${prUrl ? ` avec PR: ${prUrl}` : ''}`);
    return true;
  } catch (e) {
    console.warn(`[atlassian] closeTicket: ${(e as Error).message}`);
    return false;
  }
}

// ── Xray Test Run ─────────────────────────────────────────────────────────────

export interface XrayTestRun {
  id:  string;
  key: string;
}

export async function createXrayTestRun(
  crash: CrashInfo,
  jiraTicketKey?: string,
): Promise<XrayTestRun | null> {
  const cfg = getConfig();
  if (!cfg) return null;

  try {
    // Create a test execution ticket (Xray's Test Execution issue type)
    const body = {
      fields: {
        project:     { key: cfg.projectKey },
        summary:     `[Xray] Test Run Échoué — ${crash.route} — ${crash.traceId}`,
        description: {
          type: 'doc', version: 1,
          content: [{
            type: 'paragraph',
            content: [{
              type: 'text',
              text: `Test Run automatisé par test-end-to-end.\nVerdict: ${crash.verdict}\nRoute: ${crash.route}\n${jiraTicketKey ? `Bug lié: ${jiraTicketKey}` : ''}`,
            }],
          }],
        },
        issuetype: { name: 'Test Execution' },
        labels:    ['e2e-autonomous', 'xray', 'failed'],
      },
    };

    const result = await jiraFetch<{ id: string; key: string }>(
      cfg, '/issue', { method: 'POST', body: JSON.stringify(body) },
    );

    console.log(`[atlassian] Xray Test Execution créé → ${cfg.url}/browse/${result.key}`);
    return { id: result.id, key: result.key };
  } catch (e) {
    console.warn(`[atlassian] createXrayTestRun: ${(e as Error).message}`);
    return null;
  }
}

export async function resolveXrayTestRun(
  executionKey: string,
  passed: boolean,
): Promise<boolean> {
  const cfg = getConfig();
  if (!cfg) return false;

  try {
    const status = passed ? 'PASS' : 'FAIL';
    await jiraFetch<unknown>(cfg, `/issue/${executionKey}`, {
      method: 'PUT',
      body:   JSON.stringify({
        fields: {
          labels: ['e2e-autonomous', 'xray', status.toLowerCase()],
        },
      }),
    });
    console.log(`[atlassian] Xray ${executionKey} → ${status}`);
    return true;
  } catch (e) {
    console.warn(`[atlassian] resolveXrayTestRun: ${(e as Error).message}`);
    return false;
  }
}

// ── Public convenience function ────────────────────────────────────────────────

export async function onCrash(crash: CrashInfo): Promise<{ jiraKey?: string; xrayKey?: string }> {
  const [ticket, xray] = await Promise.all([
    createBugTicket(crash),
    createXrayTestRun(crash),
  ]);
  return { jiraKey: ticket?.key, xrayKey: xray?.key };
}

export async function onPatch(jiraKey: string, prUrl?: string): Promise<void> {
  await Promise.all([
    closeTicket(jiraKey, prUrl),
    resolveXrayTestRun(jiraKey, true),
  ]);
}

export function atlassianEnabled(): boolean {
  return !!(process.env.JIRA_URL && process.env.JIRA_TOKEN);
}
