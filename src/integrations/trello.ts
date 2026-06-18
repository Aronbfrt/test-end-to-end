/**
 * trello.ts — Intégration Trello (mode Startup).
 *
 * Crée une carte dans "To Do" au crash, déplace dans "Done" après le patch.
 *
 * Variables requises dans .env :
 *   TRELLO_API_KEY      clé API Trello (https://trello.com/app-key)
 *   TRELLO_TOKEN        token OAuth Trello
 *   TRELLO_BOARD_ID     ID du board (dans l'URL Trello)
 *   TRELLO_TODO_LIST_ID ID de la liste "To Do"
 *   TRELLO_DONE_LIST_ID ID de la liste "Done"
 */

// ── Config ────────────────────────────────────────────────────────────────────

interface TrelloConfig {
  apiKey:     string;
  token:      string;
  todoListId: string;
  doneListId: string;
}

function getConfig(): TrelloConfig | null {
  const apiKey     = process.env.TRELLO_API_KEY;
  const token      = process.env.TRELLO_TOKEN;
  const todoListId = process.env.TRELLO_TODO_LIST_ID;
  const doneListId = process.env.TRELLO_DONE_LIST_ID;

  if (!apiKey || !token || !todoListId || !doneListId) return null;
  return { apiKey, token, todoListId, doneListId };
}

function qs(cfg: TrelloConfig): string {
  return `key=${cfg.apiKey}&token=${cfg.token}`;
}

// ── Trello REST helpers ───────────────────────────────────────────────────────

const BASE = 'https://api.trello.com/1';

async function trelloFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Trello API ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

// ── Card operations ───────────────────────────────────────────────────────────

export interface CrashInfo {
  traceId:    string;
  route:      string;
  verdict:    string;
  confidence: number;
  reasoning:  string;
  targetPath: string;
}

export interface TrelloCard {
  id:        string;
  name:      string;
  shortUrl:  string;
  idList:    string;
}

export async function createCrashCard(crash: CrashInfo): Promise<TrelloCard | null> {
  const cfg = getConfig();
  if (!cfg) {
    console.log('[trello] TRELLO_* manquants — carte non créée');
    return null;
  }

  try {
    const priority = crash.confidence > 0.8 ? '🔴 CRITIQUE' : crash.confidence > 0.5 ? '🟠 HAUTE' : '🟡 MOYENNE';
    const name  = `[${crash.verdict}] ${crash.route} — ${crash.traceId.slice(0, 12)}`;
    const desc  = [
      `**Verdict** : ${crash.verdict}`,
      `**Route** : \`${crash.route}\``,
      `**Confiance** : ${(crash.confidence * 100).toFixed(0)}%`,
      `**Priorité** : ${priority}`,
      ``,
      `**Diagnostic :**`,
      crash.reasoning,
      ``,
      `**TraceID** : \`${crash.traceId}\``,
      `**Projet** : ${crash.targetPath.split('/').pop()}`,
      ``,
      `---`,
      `*Créé automatiquement par test-end-to-end Coroner*`,
    ].join('\n');

    const params = new URLSearchParams({
      name,
      desc,
      idList: cfg.todoListId,
      pos:    'top',
    });

    const card = await trelloFetch<TrelloCard>(
      `/cards?${qs(cfg)}`,
      { method: 'POST', body: params.toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
    );

    // Add red label for critical/high
    if (crash.confidence > 0.5) {
      await trelloFetch<unknown>(`/cards/${card.id}/labels?${qs(cfg)}`, {
        method: 'POST',
        body:   JSON.stringify({ color: crash.confidence > 0.8 ? 'red' : 'orange', name: crash.verdict }),
      }).catch(() => { /* non-fatal */ });
    }

    console.log(`[trello] Carte créée → ${card.shortUrl}`);
    return card;
  } catch (e) {
    console.warn(`[trello] createCrashCard: ${(e as Error).message}`);
    return null;
  }
}

export async function moveCardToDone(
  cardId: string,
  comment?: string,
): Promise<boolean> {
  const cfg = getConfig();
  if (!cfg) return false;

  try {
    // Move to Done list
    await trelloFetch<unknown>(`/cards/${cardId}?${qs(cfg)}`, {
      method: 'PUT',
      body:   JSON.stringify({ idList: cfg.doneListId }),
    });

    // Add green label
    await trelloFetch<unknown>(`/cards/${cardId}/labels?${qs(cfg)}`, {
      method: 'POST',
      body:   JSON.stringify({ color: 'green', name: 'Fixed' }),
    }).catch(() => { /* non-fatal */ });

    // Add comment if provided
    if (comment) {
      await trelloFetch<unknown>(`/cards/${cardId}/actions/comments?${qs(cfg)}`, {
        method: 'POST',
        body:   JSON.stringify({ text: comment }),
      }).catch(() => { /* non-fatal */ });
    }

    console.log(`[trello] Carte ${cardId} déplacée → Done`);
    return true;
  } catch (e) {
    console.warn(`[trello] moveCardToDone: ${(e as Error).message}`);
    return false;
  }
}

export async function addCardComment(cardId: string, text: string): Promise<boolean> {
  const cfg = getConfig();
  if (!cfg) return false;

  try {
    await trelloFetch<unknown>(`/cards/${cardId}/actions/comments?${qs(cfg)}`, {
      method: 'POST',
      body:   JSON.stringify({ text }),
    });
    return true;
  } catch (e) {
    console.warn(`[trello] addCardComment: ${(e as Error).message}`);
    return false;
  }
}

// ── Find card by name pattern ─────────────────────────────────────────────────

export async function findCardByTrace(traceId: string): Promise<TrelloCard | null> {
  const cfg = getConfig();
  if (!cfg) return null;

  try {
    const cards = await trelloFetch<TrelloCard[]>(`/lists/${cfg.todoListId}/cards?${qs(cfg)}`);
    return cards.find((c) => c.name.includes(traceId.slice(0, 12))) ?? null;
  } catch {
    return null;
  }
}

// ── Public convenience ────────────────────────────────────────────────────────

export async function onCrash(crash: CrashInfo): Promise<string | null> {
  const card = await createCrashCard(crash);
  return card?.id ?? null;
}

export async function onPatch(traceId: string, prUrl?: string): Promise<void> {
  const card = await findCardByTrace(traceId);
  if (card) {
    const comment = prUrl
      ? `✅ Correctif déployé par Ghostwriter.\nPR: ${prUrl}`
      : '✅ Correctif déployé par Ghostwriter.';
    await moveCardToDone(card.id, comment);
  }
}

export function trelloEnabled(): boolean {
  return !!(process.env.TRELLO_API_KEY && process.env.TRELLO_TOKEN &&
            process.env.TRELLO_TODO_LIST_ID && process.env.TRELLO_DONE_LIST_ID);
}
