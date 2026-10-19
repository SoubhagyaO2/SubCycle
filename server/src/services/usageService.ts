import type { Pool, PoolClient } from 'pg';
import { graceEndsAt, hasAccess, type SubscriptionStatus } from '../lib/access';
import type { Clock } from '../lib/clock';
import { AppError, notFound, paymentRequired, tooManyRequests, validationError } from '../lib/errors';
import { withTransaction } from '../db/transaction';

/** Accounting rules: docs/DECISIONS.md B13a. */
export const MAX_QUANTITY = 1_000_000;
export const METRIC_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;

export interface UsageDeps {
  pool: Pool;
  clock: Clock;
}

export type LimitSpec = { kind: 'unlimited' } | { kind: 'limited'; limit: number };

/**
 * JSON null = unlimited. A non-negative integer = cap (0 = not allowed). Anything else is MALFORMED and denies
 * (cap 0) instead of silently granting unlimited use.
 */
export function parseLimit(raw: unknown): LimitSpec {
  if (raw === null) return { kind: 'unlimited' };
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) return { kind: 'limited', limit: raw };
  return { kind: 'limited', limit: 0 };
}

export interface MetricUsage {
  metric: string;
  used: number;
  limit: number | null;
  remaining: number | null;
  unlimited: boolean;
}

export interface ConsumeResult {
  replayed: boolean;
  eventId: string;
  usage: MetricUsage;
  subscription: { id: string; status: SubscriptionStatus };
  periodStart: Date;
  periodEnd: Date;
}

interface LockedSubscription {
  id: string;
  status: SubscriptionStatus;
  current_period_start: Date;
  current_period_end: Date;
  past_due_since: Date | null;
  limits: Record<string, unknown>;
}

const toUsage = (metric: string, used: number, spec: LimitSpec): MetricUsage =>
  spec.kind === 'unlimited'
    ? { metric, used, limit: null, remaining: null, unlimited: true }
    : { metric, used, limit: spec.limit, remaining: Math.max(0, spec.limit - used), unlimited: false };

// ---- reads -------------------------------------------------------------------------------------------------------

export interface UsageReport {
  subscription: { id: string; status: SubscriptionStatus; accessAllowed: boolean; graceEndsAt: string | null };
  period: { start: string; end: string };
  usage: MetricUsage[];
}

/** Read-only report for every metric of the current plan. Works for any open subscription (paused included). */
export async function getUsage(deps: UsageDeps, userId: string): Promise<UsageReport> {
  const { rows } = await deps.pool.query<LockedSubscription>(
    `SELECT s.id, s.status, s.current_period_start, s.current_period_end, s.past_due_since, p.limits
     FROM subscriptions s JOIN plans p ON p.id = s.plan_id
     WHERE s.user_id = $1 AND s.status <> 'canceled'`,
    [userId],
  );
  const sub = rows[0];
  if (!sub) throw notFound('No active subscription found', 'SUBSCRIPTION_NOT_FOUND');
  const used = await deps.pool.query<{ metric: string; quantity: string }>(
    'SELECT metric, quantity FROM usage_records WHERE subscription_id = $1 AND period_start = $2',
    [sub.id, sub.current_period_start],
  );
  const usedByMetric = new Map(used.rows.map((r) => [r.metric, Number(r.quantity)]));
  const now = deps.clock.now();
  return {
    subscription: {
      id: sub.id,
      status: sub.status,
      accessAllowed: hasAccess({ status: sub.status, pastDueSince: sub.past_due_since, currentPeriodEnd: sub.current_period_end }, now),
      graceEndsAt: sub.past_due_since ? graceEndsAt(sub.past_due_since).toISOString() : null,
    },
    period: { start: sub.current_period_start.toISOString(), end: sub.current_period_end.toISOString() },
    usage: Object.keys(sub.limits)
      .sort()
      .map((metric) => toUsage(metric, usedByMetric.get(metric) ?? 0, parseLimit(sub.limits[metric]))),
  };
}

// ---- consumption -------------------------------------------------------------------------------------------------

export interface ConsumeInput {
  userId: string;
  metric: string;
  quantity: number;
  source: 'api' | 'demo';
  /** Client Idempotency-Key: makes recording exactly-once. */
  requestKey?: string | null;
}

export function validateQuantity(quantity: unknown): number {
  if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
    throw validationError(`quantity must be an integer between 1 and ${MAX_QUANTITY}`, { field: 'quantity' });
  }
  return quantity;
}

/**
 * Core of usage accounting. MUST run inside a transaction (`client`); the caller commits or rolls back, so usage is
 * consumed if and only if the surrounding transaction commits.
 *  1. FOR SHARE-lock the caller's open subscription (serialises with pause/cancel/upgrade, which take FOR UPDATE);
 *  2. enforce the access policy with the single hasAccess() rule;
 *  3. resolve the limit from the plan that is current right now;
 *  4. dedupe by request key (ledger row in this same transaction);
 *  5. conditional atomic upsert: the limit is checked and the counter incremented in ONE statement.
 */
export async function consumeUsage(client: PoolClient, deps: Pick<UsageDeps, 'clock'>, input: ConsumeInput): Promise<ConsumeResult> {
  if (!METRIC_PATTERN.test(input.metric)) throw validationError('Invalid metric name', { field: 'metric' });
  validateQuantity(input.quantity);

  const { rows } = await client.query<LockedSubscription>(
    `SELECT s.id, s.status, s.current_period_start, s.current_period_end, s.past_due_since, p.limits
     FROM subscriptions s JOIN plans p ON p.id = s.plan_id
     WHERE s.user_id = $1 AND s.status <> 'canceled'
     FOR SHARE OF s`,
    [input.userId],
  );
  const sub = rows[0];
  const now = deps.clock.now();
  if (!sub) throw paymentRequired('SUBSCRIPTION_REQUIRED', 'An active subscription is required to record usage');
  if (!hasAccess({ status: sub.status, pastDueSince: sub.past_due_since, currentPeriodEnd: sub.current_period_end }, now)) {
    // 'active' can only be refused because the stored period has ended and renewal has not been processed yet (B19).
    const expired = sub.status === 'active';
    throw paymentRequired(
      'SUBSCRIPTION_INACTIVE',
      expired ? 'Your billing period has ended and renewal is being processed; usage is not allowed until it completes' : `Your subscription is ${sub.status.replace('_', ' ')}; usage is not allowed`,
      {
        status: sub.status,
        reason: expired ? 'period_ended' : sub.status === 'past_due' ? 'grace_expired' : sub.status,
        periodEnd: sub.current_period_end.toISOString(),
        graceEndsAt: sub.past_due_since ? graceEndsAt(sub.past_due_since).toISOString() : null,
      },
    );
  }

  if (!Object.prototype.hasOwnProperty.call(sub.limits, input.metric)) {
    throw validationError(`Metric "${input.metric}" is not part of your plan`, { code: 'UNKNOWN_METRIC', metric: input.metric, allowed: Object.keys(sub.limits).sort() });
  }
  const spec = parseLimit(sub.limits[input.metric]);
  const limit = spec.kind === 'limited' ? spec.limit : null;
  const base = { subscription: { id: sub.id, status: sub.status }, periodStart: sub.current_period_start, periodEnd: sub.current_period_end };

  let eventId: string | null = null;
  if (input.requestKey) {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO usage_events (subscription_id, metric, period_start, quantity, source, request_key, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (subscription_id, request_key) WHERE request_key IS NOT NULL DO NOTHING
       RETURNING id`,
      [sub.id, input.metric, sub.current_period_start, input.quantity, input.source, input.requestKey, now],
    );
    if (!inserted.rows[0]) return replay(client, sub, input, spec, base);
    eventId = inserted.rows[0].id;
  }

  // The atomic heart: check the limit and increment in one statement. No row back => the limit would be exceeded.
  const upsert = await client.query<{ quantity: string }>(
    `INSERT INTO usage_records (subscription_id, metric, period_start, quantity, updated_at)
     SELECT $1, $2, $3, $4::bigint, $5
     WHERE $6::bigint IS NULL OR $4::bigint <= $6::bigint
     ON CONFLICT (subscription_id, metric, period_start)
     DO UPDATE SET quantity = usage_records.quantity + EXCLUDED.quantity, updated_at = EXCLUDED.updated_at
       WHERE $6::bigint IS NULL OR usage_records.quantity + EXCLUDED.quantity <= $6::bigint
     RETURNING quantity`,
    [sub.id, input.metric, sub.current_period_start, input.quantity, now, limit],
  );
  if (!upsert.rows[0]) {
    const current = await client.query<{ quantity: string }>(
      'SELECT quantity FROM usage_records WHERE subscription_id = $1 AND metric = $2 AND period_start = $3',
      [sub.id, input.metric, sub.current_period_start],
    );
    const used = Number(current.rows[0]?.quantity ?? 0);
    const cap = limit ?? 0;
    // The caller's transaction rolls back, taking any ledger row inserted above with it.
    throw tooManyRequests('LIMIT_EXCEEDED', `Limit reached for "${input.metric}"`, {
      metric: input.metric,
      limit: cap,
      used,
      remaining: Math.max(0, cap - used),
      requested: input.quantity,
      periodEnd: sub.current_period_end.toISOString(),
    });
  }

  if (!eventId) {
    const ev = await client.query<{ id: string }>(
      `INSERT INTO usage_events (subscription_id, metric, period_start, quantity, source, request_key, created_at)
       VALUES ($1, $2, $3, $4, $5, NULL, $6) RETURNING id`,
      [sub.id, input.metric, sub.current_period_start, input.quantity, input.source, now],
    );
    eventId = ev.rows[0]!.id;
  }
  return { replayed: false, eventId, usage: toUsage(input.metric, Number(upsert.rows[0].quantity), spec), ...base };
}

async function replay(
  client: PoolClient,
  sub: LockedSubscription,
  input: ConsumeInput,
  spec: LimitSpec,
  base: Pick<ConsumeResult, 'subscription' | 'periodStart' | 'periodEnd'>,
): Promise<ConsumeResult> {
  const { rows } = await client.query<{ id: string; metric: string; quantity: string }>(
    'SELECT id, metric, quantity FROM usage_events WHERE subscription_id = $1 AND request_key = $2',
    [sub.id, input.requestKey],
  );
  const original = rows[0]!;
  if (original.metric !== input.metric || Number(original.quantity) !== input.quantity) {
    throw new AppError(422, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different usage record');
  }
  const cur = await client.query<{ quantity: string }>(
    'SELECT quantity FROM usage_records WHERE subscription_id = $1 AND metric = $2 AND period_start = $3',
    [sub.id, input.metric, sub.current_period_start],
  );
  return { replayed: true, eventId: original.id, usage: toUsage(input.metric, Number(cur.rows[0]?.quantity ?? 0), spec), ...base };
}

/** POST /usage: records usage that has ALREADY happened (or reserves it), in its own short transaction. */
export async function recordUsage(deps: UsageDeps, input: ConsumeInput): Promise<ConsumeResult> {
  return withTransaction(deps.pool, (client) => consumeUsage(client, deps, { ...input, source: 'api' }));
}
