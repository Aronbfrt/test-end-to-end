/**
 * notifier.ts — ChatOps hub (Slack · Discord · Teams).
 *
 * Reads webhook URLs from env. All calls fire-and-forget:
 * a notifier failure NEVER crashes the main pipeline.
 *
 * Event types:
 *  - CRASH   → 🔴 immediate alert with route, verdict, stack
 *  - PATCH   → 🟢 victory message when Ghostwriter deploys a fix
 *  - SENTINEL → 🔵 PR security review result
 *  - METRICS → 📊 periodic FinOps / Green-IT digest
 */

import type { TriageResult } from '../agents/coroner.js';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface CrashPayload {
  traceId:    string;
  route:      string;
  verdict:    string;
  confidence: number;
  reasoning:  string;
  targetPath: string;
}

export interface PatchPayload {
  traceId:      string;
  route:        string;
  filesPatched: string[];
  targetPath:   string;
}

export interface SentinelPayload {
  prNumber: number;
  prTitle:  string;
  decision: 'APPROVE' | 'REJECT';
  summary:  string;
  repo:     string;
}

export interface MetricsPayload {
  tokensSaved:   number;
  co2SavedMg:    number;
  finOpsSavedUsd: number;
  totalAudits:   number;
  totalPatches:  number;
  rgpdMasked:    number;
}

// ── Internal helpers ───────────────────────────────────────────────────────────

function env(key: string): string {
  return process.env[key] ?? '';
}

async function post(url: string, body: unknown): Promise<void> {
  try {
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
      signal:  AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.warn(`[notifier] HTTP ${res.status} from ${new URL(url).hostname}`);
    }
  } catch (e) {
    console.warn(`[notifier] send failed: ${(e as Error).message}`);
  }
}

function ts(): string {
  return new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });
}

// ── Slack (Block Kit) ─────────────────────────────────────────────────────────

async function slackCrash(p: CrashPayload): Promise<void> {
  const url = env('SLACK_WEBHOOK_URL');
  if (!url) return;
  await post(url, {
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: `🔴 Crash détecté — ${p.verdict}`, emoji: true },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Route*\n\`${p.route}\`` },
          { type: 'mrkdwn', text: `*Confiance*\n${(p.confidence * 100).toFixed(0)}%` },
          { type: 'mrkdwn', text: `*TraceID*\n\`${p.traceId}\`` },
          { type: 'mrkdwn', text: `*Projet*\n\`${p.targetPath.split('/').pop()}\`` },
        ],
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*Diagnostic*\n${p.reasoning}` },
      },
      { type: 'divider' },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `test-end-to-end • ${ts()}` }],
      },
    ],
  });
}

async function slackPatch(p: PatchPayload): Promise<void> {
  const url = env('SLACK_WEBHOOK_URL');
  if (!url) return;
  await post(url, {
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: `🟢 Patch déployé — ${p.route}`, emoji: true },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*TraceID*\n\`${p.traceId}\`` },
          { type: 'mrkdwn', text: `*Fichiers patchés*\n${p.filesPatched.length}` },
        ],
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: p.filesPatched.map((f) => `• \`${f}\``).join('\n'),
        },
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `Ghostwriter • ${ts()}` }],
      },
    ],
  });
}

async function slackSentinel(p: SentinelPayload): Promise<void> {
  const url = env('SLACK_WEBHOOK_URL');
  if (!url) return;
  const icon = p.decision === 'APPROVE' ? '🔵 Approuvé' : '🟠 Rejeté';
  await post(url, {
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: `${icon} — PR #${p.prNumber}`, emoji: true },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Titre*\n${p.prTitle}` },
          { type: 'mrkdwn', text: `*Repo*\n\`${p.repo}\`` },
        ],
      },
      { type: 'section', text: { type: 'mrkdwn', text: p.summary } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `Sentinel • ${ts()}` }] },
    ],
  });
}

async function slackMetrics(p: MetricsPayload): Promise<void> {
  const url = env('SLACK_WEBHOOK_URL');
  if (!url) return;
  await post(url, {
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: '📊 Rapport FinOps / Green-IT', emoji: true },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Tokens économisés*\n${p.tokensSaved.toLocaleString()}` },
          { type: 'mrkdwn', text: `*CO₂ évité*\n${p.co2SavedMg.toFixed(1)} mg` },
          { type: 'mrkdwn', text: `*FinOps ($)*\n$${p.finOpsSavedUsd.toFixed(4)}` },
          { type: 'mrkdwn', text: `*Audits*\n${p.totalAudits}` },
          { type: 'mrkdwn', text: `*Patches*\n${p.totalPatches}` },
          { type: 'mrkdwn', text: `*RGPD masqués*\n${p.rgpdMasked}` },
        ],
      },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `test-end-to-end • ${ts()}` }] },
    ],
  });
}

// ── Discord (embeds) ──────────────────────────────────────────────────────────

async function discordCrash(p: CrashPayload): Promise<void> {
  const url = env('DISCORD_WEBHOOK_URL');
  if (!url) return;
  await post(url, {
    embeds: [{
      title:       `🔴 Crash — ${p.verdict}`,
      color:       0xe74c3c,
      description: p.reasoning,
      fields: [
        { name: 'Route',      value: `\`${p.route}\``,                        inline: true },
        { name: 'Confiance',  value: `${(p.confidence * 100).toFixed(0)}%`,   inline: true },
        { name: 'TraceID',    value: `\`${p.traceId}\``,                      inline: false },
      ],
      footer: { text: `test-end-to-end • ${ts()}` },
    }],
  });
}

async function discordPatch(p: PatchPayload): Promise<void> {
  const url = env('DISCORD_WEBHOOK_URL');
  if (!url) return;
  await post(url, {
    embeds: [{
      title:       `🟢 Patch déployé — ${p.route}`,
      color:       0x2ecc71,
      description: p.filesPatched.map((f) => `• \`${f}\``).join('\n'),
      fields: [
        { name: 'TraceID', value: `\`${p.traceId}\``, inline: true },
      ],
      footer: { text: `Ghostwriter • ${ts()}` },
    }],
  });
}

async function discordSentinel(p: SentinelPayload): Promise<void> {
  const url = env('DISCORD_WEBHOOK_URL');
  if (!url) return;
  const color = p.decision === 'APPROVE' ? 0x3498db : 0xe67e22;
  const icon  = p.decision === 'APPROVE' ? '🔵' : '🟠';
  await post(url, {
    embeds: [{
      title:       `${icon} Sentinel — PR #${p.prNumber} ${p.decision}`,
      color,
      description: p.summary,
      fields: [
        { name: 'Titre', value: p.prTitle, inline: false },
        { name: 'Repo',  value: `\`${p.repo}\``,   inline: true },
      ],
      footer: { text: `Sentinel • ${ts()}` },
    }],
  });
}

// ── Teams (Adaptive Card) ─────────────────────────────────────────────────────

async function teamsMessage(title: string, body: string, color: string): Promise<void> {
  const url = env('TEAMS_WEBHOOK_URL');
  if (!url) return;
  await post(url, {
    '@type':    'MessageCard',
    '@context': 'http://schema.org/extensions',
    themeColor: color,
    summary:    title,
    sections: [{
      activityTitle:    title,
      activitySubtitle: `test-end-to-end • ${ts()}`,
      text:             body,
    }],
  });
}

// ── Public API ─────────────────────────────────────────────────────────────────

export async function notifyCrash(payload: CrashPayload): Promise<void> {
  await Promise.allSettled([
    slackCrash(payload),
    discordCrash(payload),
    teamsMessage(
      `🔴 Crash ${payload.verdict} — ${payload.route}`,
      payload.reasoning,
      'e74c3c',
    ),
  ]);
}

export async function notifyPatch(payload: PatchPayload): Promise<void> {
  await Promise.allSettled([
    slackPatch(payload),
    discordPatch(payload),
    teamsMessage(
      `🟢 Patch déployé — ${payload.route}`,
      payload.filesPatched.map((f) => `• ${f}`).join('\n'),
      '2ecc71',
    ),
  ]);
}

export async function notifySentinel(payload: SentinelPayload): Promise<void> {
  await Promise.allSettled([
    slackSentinel(payload),
    discordSentinel(payload),
    teamsMessage(
      `${payload.decision === 'APPROVE' ? '🔵' : '🟠'} Sentinel PR #${payload.prNumber} — ${payload.decision}`,
      payload.summary,
      payload.decision === 'APPROVE' ? '3498db' : 'e67e22',
    ),
  ]);
}

export async function notifyMetrics(payload: MetricsPayload): Promise<void> {
  await Promise.allSettled([
    slackMetrics(payload),
    teamsMessage(
      '📊 Rapport FinOps / Green-IT',
      [
        `Tokens économisés : ${payload.tokensSaved.toLocaleString()}`,
        `CO₂ évité : ${payload.co2SavedMg.toFixed(1)} mg`,
        `FinOps : $${payload.finOpsSavedUsd.toFixed(4)}`,
      ].join('\n'),
      '9b59b6',
    ),
  ]);
}

export function notifierEnabled(): boolean {
  return !!(env('SLACK_WEBHOOK_URL') || env('DISCORD_WEBHOOK_URL') || env('TEAMS_WEBHOOK_URL'));
}
