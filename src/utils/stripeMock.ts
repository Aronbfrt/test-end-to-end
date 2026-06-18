/**
 * stripeMock.ts — Simulateur de cycle de vie Stripe (test env uniquement).
 *
 * Génère des payloads de cartes bancaires factices et des webhooks Stripe
 * signés cryptographiquement pour éprouver les routes de checkout.
 *
 * IMPORTANT : Aucun appel vers les serveurs Stripe réels. 100% local.
 * Utiliser uniquement en environnement de test.
 *
 * Événements simulables :
 *   charge.succeeded, charge.failed, invoice.payment_failed,
 *   invoice.payment_succeeded, checkout.session.completed,
 *   customer.subscription.deleted, payment_intent.requires_action
 */

import { createHmac, randomUUID } from 'node:crypto';

// ── Test card numbers (Stripe convention, Luhn-valid) ──────────────────────────

export const TEST_CARDS = {
  visa_success:       { number: '4242424242424242', brand: 'Visa',       cvc: '314', exp: '12/34' },
  visa_debit:         { number: '4000056655665556', brand: 'Visa Debit', cvc: '314', exp: '12/34' },
  mastercard_success: { number: '5555555555554444', brand: 'Mastercard', cvc: '314', exp: '12/34' },
  amex_success:       { number: '378282246310005',  brand: 'Amex',       cvc: '3141', exp: '12/34' },
  declined_generic:   { number: '4000000000000002', brand: 'Visa',       cvc: '314', exp: '12/34' },
  declined_funds:     { number: '4000000000009995', brand: 'Visa',       cvc: '314', exp: '12/34' },
  auth_required:      { number: '4000002500003155', brand: 'Visa',       cvc: '314', exp: '12/34' },
  three_d_secure:     { number: '4000000000003220', brand: 'Visa',       cvc: '314', exp: '12/34' },
} as const;

export type CardType = keyof typeof TEST_CARDS;

// ── Payload builders ───────────────────────────────────────────────────────────

function baseObject(id: string, type: string, extraData: Record<string, unknown>) {
  return {
    id,
    object: type,
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    ...extraData,
  };
}

function chargeObject(
  amount: number,
  currency: string,
  card: (typeof TEST_CARDS)[CardType],
  paid: boolean,
) {
  const chargeId = `ch_test_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  return baseObject(chargeId, 'charge', {
    amount,
    amount_captured: paid ? amount : 0,
    currency,
    paid,
    status: paid ? 'succeeded' : 'failed',
    failure_code:    paid ? null : 'card_declined',
    failure_message: paid ? null : 'Your card was declined.',
    payment_method_details: {
      card: {
        brand:    card.brand.toLowerCase(),
        last4:    card.number.slice(-4),
        exp_month: parseInt(card.exp.split('/')[0] ?? '12', 10),
        exp_year:  parseInt(`20${card.exp.split('/')[1] ?? '34'}`, 10),
        country: 'US',
        funding: 'credit',
      },
      type: 'card',
    },
    metadata: {},
  });
}

function paymentIntentObject(
  amount: number,
  currency: string,
  status: 'succeeded' | 'payment_failed' | 'requires_action',
) {
  const piId = `pi_test_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  return baseObject(piId, 'payment_intent', {
    amount,
    currency,
    status,
    client_secret: `${piId}_secret_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
    payment_method_types: ['card'],
    metadata: {},
  });
}

function customerObject(email: string) {
  const custId = `cus_test_${randomUUID().replace(/-/g, '').slice(0, 14)}`;
  return baseObject(custId, 'customer', {
    email,
    name: 'Test User',
    metadata: {},
  });
}

function subscriptionObject(customerId: string, priceId: string) {
  const subId = `sub_test_${randomUUID().replace(/-/g, '').slice(0, 14)}`;
  return baseObject(subId, 'subscription', {
    customer: customerId,
    status:   'active',
    items: {
      object: 'list',
      data: [{ id: `si_test_${Date.now()}`, price: { id: priceId, currency: 'eur' } }],
    },
    current_period_start: Math.floor(Date.now() / 1000),
    current_period_end:   Math.floor(Date.now() / 1000) + 30 * 86400,
    metadata: {},
  });
}

// ── Webhook event builder ─────────────────────────────────────────────────────

export type WebhookEventType =
  | 'charge.succeeded'
  | 'charge.failed'
  | 'invoice.payment_succeeded'
  | 'invoice.payment_failed'
  | 'checkout.session.completed'
  | 'customer.subscription.deleted'
  | 'payment_intent.succeeded'
  | 'payment_intent.payment_failed'
  | 'payment_intent.requires_action';

export interface WebhookEvent {
  id:      string;
  object:  'event';
  type:    WebhookEventType;
  created: number;
  livemode: false;
  data:    { object: Record<string, unknown> };
}

export function buildWebhookEvent(
  type: WebhookEventType,
  options: {
    amount?:   number;
    currency?: string;
    card?:     CardType;
    email?:    string;
    priceId?:  string;
  } = {},
): WebhookEvent {
  const {
    amount   = 2000,
    currency = 'eur',
    card     = 'visa_success',
    email    = '[MASKED_EMAIL]',
    priceId  = 'price_test_123',
  } = options;

  const cardData = TEST_CARDS[card];

  let dataObject: Record<string, unknown>;

  switch (type) {
    case 'charge.succeeded':
      dataObject = chargeObject(amount, currency, cardData, true);
      break;
    case 'charge.failed':
      dataObject = chargeObject(amount, currency, TEST_CARDS.declined_generic, false);
      break;
    case 'payment_intent.succeeded':
      dataObject = paymentIntentObject(amount, currency, 'succeeded');
      break;
    case 'payment_intent.payment_failed':
      dataObject = paymentIntentObject(amount, currency, 'payment_failed');
      break;
    case 'payment_intent.requires_action':
      dataObject = paymentIntentObject(amount, currency, 'requires_action');
      break;
    case 'invoice.payment_succeeded':
    case 'invoice.payment_failed': {
      const invId = `in_test_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
      dataObject = baseObject(invId, 'invoice', {
        amount_due:  amount,
        amount_paid: type === 'invoice.payment_succeeded' ? amount : 0,
        currency,
        status: type === 'invoice.payment_succeeded' ? 'paid' : 'open',
        customer_email: email,
        paid: type === 'invoice.payment_succeeded',
      });
      break;
    }
    case 'checkout.session.completed': {
      const sessId = `cs_test_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
      dataObject = baseObject(sessId, 'checkout.session', {
        amount_total: amount,
        currency,
        customer_email: email,
        payment_status: 'paid',
        status: 'complete',
        metadata: {},
      });
      break;
    }
    case 'customer.subscription.deleted': {
      const cust = customerObject(email);
      dataObject = subscriptionObject(cust.id, priceId);
      (dataObject as Record<string, unknown>).status = 'canceled';
      break;
    }
    default:
      dataObject = {};
  }

  return {
    id:       `evt_test_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    object:   'event',
    type,
    created:  Math.floor(Date.now() / 1000),
    livemode: false,
    data:     { object: dataObject },
  };
}

// ── Webhook signing (Stripe-compatible HMAC) ───────────────────────────────────

export interface SignedWebhook {
  payload:   string;
  signature: string;
  timestamp: number;
}

export function signWebhook(event: WebhookEvent, secret?: string): SignedWebhook {
  const webhookSecret = secret ?? process.env.STRIPE_WEBHOOK_SECRET ?? 'whsec_test_fallback';
  const payload       = JSON.stringify(event);
  const timestamp     = Math.floor(Date.now() / 1000);
  const signedPayload = `${timestamp}.${payload}`;

  const key = webhookSecret.startsWith('whsec_')
    ? Buffer.from(webhookSecret.replace('whsec_', ''), 'base64')
    : Buffer.from(webhookSecret, 'utf-8');

  const hmac = createHmac('sha256', key).update(signedPayload).digest('hex');
  const signature = `t=${timestamp},v1=${hmac}`;

  return { payload, signature, timestamp };
}

// ── HTTP delivery to target route ─────────────────────────────────────────────

export interface DeliveryResult {
  event:      WebhookEventType;
  statusCode: number;
  ok:         boolean;
  body:       string;
  durationMs: number;
}

export async function deliverWebhook(
  webhookUrl: string,
  event: WebhookEvent,
  secret?: string,
): Promise<DeliveryResult> {
  const { payload, signature } = signWebhook(event, secret);
  const t0 = Date.now();

  try {
    const res = await fetch(webhookUrl, {
      method:  'POST',
      headers: {
        'Content-Type':        'application/json',
        'Stripe-Signature':    signature,
        'User-Agent':          'Stripe/1.0 (+https://stripe.com/docs/webhooks)',
      },
      body:   payload,
      signal: AbortSignal.timeout(10_000),
    });
    const body = await res.text().catch(() => '');
    return {
      event:      event.type,
      statusCode: res.status,
      ok:         res.status >= 200 && res.status < 300,
      body:       body.slice(0, 500),
      durationMs: Date.now() - t0,
    };
  } catch (e) {
    return {
      event:      event.type,
      statusCode: 0,
      ok:         false,
      body:       (e as Error).message,
      durationMs: Date.now() - t0,
    };
  }
}

// ── Test suite runner ─────────────────────────────────────────────────────────

export interface StripeTestSuite {
  webhookUrl:   string;
  secret?:      string;
  events?:      WebhookEventType[];
  amount?:      number;
  currency?:    string;
}

export async function runStripeSuite(suite: StripeTestSuite): Promise<DeliveryResult[]> {
  const events: WebhookEventType[] = suite.events ?? [
    'charge.succeeded',
    'charge.failed',
    'invoice.payment_succeeded',
    'invoice.payment_failed',
    'checkout.session.completed',
    'payment_intent.succeeded',
    'payment_intent.payment_failed',
    'payment_intent.requires_action',
  ];

  const results: DeliveryResult[] = [];

  for (const eventType of events) {
    const event  = buildWebhookEvent(eventType, { amount: suite.amount, currency: suite.currency });
    const result = await deliverWebhook(suite.webhookUrl, event, suite.secret);
    results.push(result);
    console.log(
      `[stripeMock] ${eventType} → HTTP ${result.statusCode} (${result.durationMs}ms) ` +
      `${result.ok ? '✓' : '✗'}`,
    );
  }

  const passed = results.filter((r) => r.ok).length;
  console.log(`[stripeMock] ${passed}/${results.length} webhooks acceptés par l'application`);
  return results;
}
