/**
 * rgpdGuard.ts — Agent de conformité RGPD / sanitisation PII.
 *
 * Intercepte tous les flux de données (crash contexts, logs Coroner, HTML)
 * avant persistance sur disque. Remplace les données personnelles par des
 * tokens anonymisés conformes : aucune donnée sensible en clair dans
 * .e2e-work/ ou les rapports générés.
 *
 * Patterns détectés :
 *   EMAIL     → [MASKED_EMAIL]
 *   PHONE     → [MASKED_PHONE]
 *   CARD      → [MASKED_CARD]
 *   IBAN      → [MASKED_IBAN]
 *   API_KEY   → [MASKED_API_KEY]
 *   JWT       → [MASKED_JWT]
 *   SECRET    → [MASKED_SECRET]
 *   IP_ADDR   → [MASKED_IP] (IPv4 privées préservées)
 */

import type { OllamaCapability } from '../orchestrator.js';

// ── Regex patterns ─────────────────────────────────────────────────────────────

const PATTERNS: Array<{ label: string; rx: RegExp; mask: string }> = [
  // JWT (avant email pour éviter faux positifs)
  {
    label: 'JWT',
    rx:    /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    mask:  '[MASKED_JWT]',
  },
  // Clés API courantes (Stripe, GitHub, AWS, Slack, OpenAI…)
  {
    label: 'API_KEY',
    rx:    /\b(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{36,}|xoxb-[0-9A-Za-z-]{40,}|AKIA[A-Z0-9]{16}|pk_live_[A-Za-z0-9]{24,}|sk_live_[A-Za-z0-9]{24,}|sk_test_[A-Za-z0-9]{24,}|pk_test_[A-Za-z0-9]{24,}|whsec_[A-Za-z0-9]{32,})/g,
    mask:  '[MASKED_API_KEY]',
  },
  // Champs JSON portant des secrets (password, token, api_key, secret)
  {
    label: 'SECRET_FIELD',
    rx:    /"(password|passwd|pwd|token|api[_-]?key|secret|private[_-]?key|auth[_-]?token)"\s*:\s*"([^"]{4,})"/gi,
    mask:  '"$1":"[MASKED_SECRET]"',
  },
  // Carte bancaire (Luhn non vérifié — pattern visuel)
  {
    label: 'CARD',
    rx:    /\b(?:\d{4}[\s\-]){3}\d{4}\b/g,
    mask:  '[MASKED_CARD]',
  },
  // IBAN (EU)
  {
    label: 'IBAN',
    rx:    /\b[A-Z]{2}\d{2}[A-Z0-9]{4}\d{7}([A-Z0-9]?){0,16}\b/g,
    mask:  '[MASKED_IBAN]',
  },
  // Email
  {
    label: 'EMAIL',
    rx:    /\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}\b/g,
    mask:  '[MASKED_EMAIL]',
  },
  // Téléphone FR/EU/US
  {
    label: 'PHONE',
    rx:    /(?:\+?33[\s.\-]?|0)(?:[1-9])(?:[\s.\-]?\d{2}){4}|\b\+?[0-9]{1,3}[\s.\-]?\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4}\b/g,
    mask:  '[MASKED_PHONE]',
  },
  // IP publiques uniquement (pas 127.x, 10.x, 192.168.x, 172.16-31.x)
  {
    label: 'PUBLIC_IP',
    rx:    /(?<!10\.|192\.168\.|127\.)(?<!172\.(?:1[6-9]|2\d|3[01])\.)(?:\d{1,3}\.){3}\d{1,3}(?=\b)/g,
    mask:  '[MASKED_IP]',
  },
];

// ── Stats ──────────────────────────────────────────────────────────────────────

let _totalMasked = 0;

export function getMaskedCount(): number {
  return _totalMasked;
}

// ── Core sanitize ─────────────────────────────────────────────────────────────

/**
 * Remplace toutes les occurrences de PII dans le texte.
 * Retourne { sanitized, count } — count = nombre de remplacements.
 */
export function sanitize(text: string): { sanitized: string; count: number } {
  let result  = text;
  let count   = 0;

  for (const { rx, mask } of PATTERNS) {
    rx.lastIndex = 0;
    const before = result;
    result = result.replace(rx, () => { count++; return mask; });
    rx.lastIndex = 0;
    if (result !== before) {
      // already counted above
    }
  }

  _totalMasked += count;
  return { sanitized: result, count };
}

/**
 * Sanitise un objet JSON (stringify → sanitize → parse).
 * Utilisé pour les crash contexts avant écriture sur disque.
 */
export function sanitizeObject<T extends object>(obj: T): { sanitized: T; count: number } {
  const raw = JSON.stringify(obj);
  const { sanitized: sanitizedStr, count } = sanitize(raw);
  return { sanitized: JSON.parse(sanitizedStr) as T, count };
}

// ── Ollama-enhanced detection (optionnel) ─────────────────────────────────────

/**
 * Si Ollama disponible, demande une analyse contextuelle pour détecter
 * des fuites non couvertes par les regex (noms propres, adresses, etc.).
 * Retourne les lignes à masquer avec leur raison.
 */
export async function auditWithLlm(
  text: string,
  ollama: OllamaCapability | null,
): Promise<{ flagged: Array<{ excerpt: string; reason: string }> }> {
  if (!ollama?.available) return { flagged: [] };

  const prompt =
    'You are a GDPR compliance auditor. Analyze the following text and list any personal data leaks ' +
    '(names, addresses, phone numbers, emails, IDs, health data, financial data) not already masked. ' +
    'Respond with a JSON array: [{"excerpt":"...","reason":"..."}]. Empty array if clean.\n\n' +
    text.slice(0, 3000);

  try {
    const res = await fetch(`${ollama.endpoint}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: ollama.model, prompt, stream: false, format: 'json' }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { flagged: [] };
    const data = await res.json() as { response?: string };
    const parsed = JSON.parse(data.response ?? '[]') as Array<{ excerpt: string; reason: string }>;
    return { flagged: Array.isArray(parsed) ? parsed : [] };
  } catch {
    return { flagged: [] };
  }
}

// ── Main agent entry point (used by orchestrator dispatch) ────────────────────

export async function run(
  text: string,
  ollama: OllamaCapability | null,
): Promise<{ sanitized: string; count: number; llmFlags: number }> {
  const { sanitized, count } = sanitize(text);

  let llmFlags = 0;
  if (ollama?.available && count === 0) {
    const { flagged } = await auditWithLlm(sanitized, ollama);
    llmFlags = flagged.length;
    if (flagged.length > 0) {
      console.warn(`[rgpdGuard] LLM flagged ${flagged.length} potential PII not caught by regex:`);
      for (const f of flagged) {
        console.warn(`  - "${f.excerpt.slice(0, 40)}…" → ${f.reason}`);
      }
    }
  }

  if (count > 0) {
    console.log(`[rgpdGuard] ${count} PII masqués (total session: ${_totalMasked})`);
  }

  return { sanitized, count, llmFlags };
}
