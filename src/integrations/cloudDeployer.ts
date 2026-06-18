/**
 * cloudDeployer.ts — Intégration hébergeurs européens + récupération logs SSH.
 *
 * Providers supportés :
 *   OVHcloud  — API REST v1 (déclenchement rebuild / restart via Project API)
 *   IONOS     — GitHub Actions workflow_dispatch (CI/CD)
 *   Hostinger — Webhook HTTP générique (POST sur URL configurée)
 *
 * Log recovery via SSH (ssh2) :
 *   Se connecte au serveur distant et récupère les dernières lignes de logs
 *   Nginx / PM2 / systemd pour enrichir le contexte des crashs.
 *
 * Variables .env :
 *   OVH_APP_KEY, OVH_APP_SECRET, OVH_CONSUMER_KEY, OVH_PROJECT_ID, OVH_SERVICE_NAME
 *   IONOS_GITHUB_REPO, IONOS_GITHUB_TOKEN, IONOS_WORKFLOW_FILE
 *   HOSTINGER_DEPLOY_WEBHOOK_URL
 *   SSH_HOST, SSH_PORT, SSH_USER, SSH_PRIVATE_KEY (chemin vers fichier clé)
 */

import { createHmac } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';

// ── SSH command whitelist ─────────────────────────────────────────────────────

const ALLOWED_SSH_COMMANDS = ['tail', 'cat', 'journalctl', 'pm2'];

function assertSafeCommand(cmd: string): void {
  for (const segment of cmd.split(/[;|&]+/).map((s) => s.trim()).filter(Boolean)) {
    const base = segment.replace(/^sudo\s+/, '').split(/\s+/)[0];
    if (base && !ALLOWED_SSH_COMMANDS.includes(base)) {
      throw new Error(`[cloudDeployer] SSH command not in whitelist: ${base}`);
    }
  }
}

// ── OVHcloud ──────────────────────────────────────────────────────────────────

interface OvhConfig {
  appKey:        string;
  appSecret:     string;
  consumerKey:   string;
  projectId:     string;
  serviceName:   string;
}

function getOvhConfig(): OvhConfig | null {
  const appKey      = process.env.OVH_APP_KEY;
  const appSecret   = process.env.OVH_APP_SECRET;
  const consumerKey = process.env.OVH_CONSUMER_KEY;
  const projectId   = process.env.OVH_PROJECT_ID;
  const serviceName = process.env.OVH_SERVICE_NAME;

  if (!appKey || !appSecret || !consumerKey || !projectId || !serviceName) return null;
  return { appKey, appSecret, consumerKey, projectId, serviceName };
}

function ovhSign(
  cfg: OvhConfig,
  method: string,
  url: string,
  body: string,
  ts: number,
): string {
  const raw = `${cfg.appSecret}+${cfg.consumerKey}+${method}+${url}+${body}+${ts}`;
  return '$1$' + createHmac('sha1', cfg.appSecret).update(raw).digest('hex');
}

async function ovhFetch<T>(
  cfg: OvhConfig,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: object,
): Promise<T> {
  const base      = 'https://eu.api.ovh.com/1.0';
  const url       = `${base}${path}`;
  const ts        = Math.floor(Date.now() / 1000);
  const bodyStr   = body ? JSON.stringify(body) : '';
  const signature = ovhSign(cfg, method, url, bodyStr, ts);

  const res = await fetch(url, {
    method,
    headers: {
      'X-Ovh-Application':  cfg.appKey,
      'X-Ovh-Consumer':     cfg.consumerKey,
      'X-Ovh-Timestamp':    String(ts),
      'X-Ovh-Signature':    signature,
      'Content-Type':       'application/json',
    },
    body: bodyStr || undefined,
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`OVH API ${res.status}: ${txt.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

export async function deployOvh(): Promise<{ success: boolean; message: string }> {
  const cfg = getOvhConfig();
  if (!cfg) {
    return { success: false, message: 'OVH_* manquants dans .env — déploiement ignoré' };
  }

  try {
    await ovhFetch(cfg, 'POST', `/cloud/project/${cfg.projectId}/instance/${cfg.serviceName}/reboot`, {
      type: 'soft',
    });
    console.log('[cloudDeployer] OVH: reboot soft envoyé');
    return { success: true, message: 'OVH reboot déclenché' };
  } catch (e) {
    console.warn(`[cloudDeployer] OVH deploy failed: ${(e as Error).message}`);
    return { success: false, message: (e as Error).message };
  }
}

// ── IONOS via GitHub Actions workflow_dispatch ────────────────────────────────

export async function deployIonosViaGitHub(): Promise<{ success: boolean; message: string }> {
  const repo     = process.env.IONOS_GITHUB_REPO;
  const token    = process.env.IONOS_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN;
  const workflow = process.env.IONOS_WORKFLOW_FILE ?? 'deploy.yml';
  const branch   = process.env.IONOS_DEPLOY_BRANCH ?? 'main';

  if (!repo || !token) {
    return { success: false, message: 'IONOS_GITHUB_REPO / IONOS_GITHUB_TOKEN manquants' };
  }

  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`,
      {
        method:  'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept':        'application/vnd.github+json',
          'Content-Type':  'application/json',
        },
        body:   JSON.stringify({ ref: branch }),
        signal: AbortSignal.timeout(10_000),
      },
    );

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`GitHub API ${res.status}: ${txt.slice(0, 200)}`);
    }

    console.log(`[cloudDeployer] IONOS: workflow ${workflow} déclenché sur ${branch}`);
    return { success: true, message: `GitHub Actions workflow ${workflow} lancé` };
  } catch (e) {
    console.warn(`[cloudDeployer] IONOS deploy failed: ${(e as Error).message}`);
    return { success: false, message: (e as Error).message };
  }
}

// ── Hostinger webhook ─────────────────────────────────────────────────────────

export async function deployHostinger(): Promise<{ success: boolean; message: string }> {
  const webhookUrl = process.env.HOSTINGER_DEPLOY_WEBHOOK_URL;

  if (!webhookUrl) {
    return { success: false, message: 'HOSTINGER_DEPLOY_WEBHOOK_URL manquant' };
  }

  try {
    const res = await fetch(webhookUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ action: 'deploy', source: 'test-end-to-end', ts: Date.now() }),
      signal:  AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      throw new Error(`Hostinger webhook HTTP ${res.status}`);
    }

    console.log('[cloudDeployer] Hostinger: webhook déclenché');
    return { success: true, message: 'Hostinger deploy webhook envoyé' };
  } catch (e) {
    console.warn(`[cloudDeployer] Hostinger deploy failed: ${(e as Error).message}`);
    return { success: false, message: (e as Error).message };
  }
}

// ── SSH log recovery (ssh2) ───────────────────────────────────────────────────

export interface SshLogResult {
  host:    string;
  lines:   string[];
  error?:  string;
}

export interface SshConfig {
  host:       string;
  port?:      number;
  username:   string;
  privateKey: string;
}

function getSshConfig(): SshConfig | null {
  const host       = process.env.SSH_HOST;
  const username   = process.env.SSH_USER;
  const keyPath    = process.env.SSH_PRIVATE_KEY;
  const port       = parseInt(process.env.SSH_PORT ?? '22', 10);

  if (!host || !username || !keyPath) return null;
  if (keyPath.includes('-----BEGIN')) {
    console.warn('[cloudDeployer] SSH_PRIVATE_KEY must be a file path, not inline key content');
    return null;
  }
  if (!existsSync(keyPath)) {
    console.warn(`[cloudDeployer] SSH_PRIVATE_KEY path not found: ${keyPath}`);
    return null;
  }

  return { host, port, username, privateKey: readFileSync(keyPath, 'utf-8') };
}

export async function recoverRemoteLogs(
  commands: string[] = [
    'sudo journalctl -u nginx --no-pager -n 100 2>/dev/null || tail -n 100 /var/log/nginx/error.log 2>/dev/null',
    'pm2 logs --nostream --lines 50 2>/dev/null',
    'sudo journalctl -u node --no-pager -n 50 2>/dev/null',
  ],
): Promise<SshLogResult> {
  const cfg = getSshConfig();
  if (!cfg) {
    return { host: 'unknown', lines: [], error: 'SSH_HOST/SSH_USER/SSH_PRIVATE_KEY manquants' };
  }

  for (const cmd of commands) {
    try {
      assertSafeCommand(cmd);
    } catch (e) {
      return { host: cfg.host, lines: [], error: (e as Error).message };
    }
  }

  return new Promise((resolve) => {
    let Client: new () => import('ssh2').Client;

    try {
      // Dynamic import so missing ssh2 doesn't crash the module load
      const ssh2 = require('ssh2') as typeof import('ssh2');
      Client = ssh2.Client;
    } catch {
      resolve({ host: cfg.host, lines: [], error: 'ssh2 non installé (npm install ssh2)' });
      return;
    }

    const conn   = new Client();
    const output: string[] = [];
    const fullCommand = commands.join('; echo "---"; ');

    conn.on('ready', () => {
      conn.exec(fullCommand, (err, stream) => {
        if (err) {
          conn.end();
          resolve({ host: cfg.host, lines: [], error: err.message });
          return;
        }

        stream.on('data', (data: Buffer) => {
          output.push(...data.toString().split('\n').filter((l) => l.trim()));
        });

        stream.stderr.on('data', (_data: Buffer) => {
          // stderr ignored — commands include 2>/dev/null where appropriate
        });

        stream.on('close', () => {
          conn.end();
          console.log(`[cloudDeployer] SSH recovered ${output.length} log lines from ${cfg.host}`);
          resolve({ host: cfg.host, lines: output.slice(-200) });
        });
      });
    });

    conn.on('error', (err) => {
      resolve({ host: cfg.host, lines: [], error: err.message });
    });

    conn.connect({
      host:         cfg.host,
      port:         cfg.port ?? 22,
      username:     cfg.username,
      privateKey:   cfg.privateKey,
      timeout:      5_000,
      readyTimeout: 10_000,
    });
  });
}

// ── Unified deploy trigger ─────────────────────────────────────────────────────

export interface DeployResult {
  ovh?:      { success: boolean; message: string };
  ionos?:    { success: boolean; message: string };
  hostinger?: { success: boolean; message: string };
  ssh?:      SshLogResult;
}

export async function triggerDeploy(fetchLogs = false): Promise<DeployResult> {
  const tasks: Promise<void>[] = [];
  const result: DeployResult   = {};

  if (process.env.OVH_APP_KEY) {
    tasks.push(deployOvh().then((r) => { result.ovh = r; }));
  }
  if (process.env.IONOS_GITHUB_REPO) {
    tasks.push(deployIonosViaGitHub().then((r) => { result.ionos = r; }));
  }
  if (process.env.HOSTINGER_DEPLOY_WEBHOOK_URL) {
    tasks.push(deployHostinger().then((r) => { result.hostinger = r; }));
  }
  if (fetchLogs && process.env.SSH_HOST) {
    tasks.push(recoverRemoteLogs().then((r) => { result.ssh = r; }));
  }

  if (tasks.length === 0) {
    console.log('[cloudDeployer] Aucun provider configuré — déploiement ignoré');
  }

  await Promise.allSettled(tasks);
  return result;
}

export function cloudDeployerEnabled(): boolean {
  return !!(
    process.env.OVH_APP_KEY ||
    process.env.IONOS_GITHUB_REPO ||
    process.env.HOSTINGER_DEPLOY_WEBHOOK_URL
  );
}
