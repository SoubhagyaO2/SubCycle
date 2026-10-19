import type { PoolClient } from 'pg';
import { graceEndsAt } from '../lib/access';
import { insertEvent, type SubscriptionRow } from '../db/subscriptionRepo';
import type { RenewalMeta } from './chargeSettlement';

/**
 * State changes of the renewal job. Every function runs inside the caller's transaction (the subscription row is
 * already locked FOR UPDATE) and writes its audit event in that same transaction. See docs/DECISIONS.md B19.
 */
const DAY_MS = 24 * 60 * 60 * 1000;

/** null when the subscription still matches the state the renewal charge was computed against. */
export function renewalDrift(sub: SubscriptionRow, meta: RenewalMeta): string | null {
  if (sub.status !== 'active' && sub.status !== 'past_due') return `subscription is ${sub.status}`;
  if (sub.current_period_end.getTime() !== new Date(meta.oldPeriodEnd).getTime()) return 'billing period changed';
  if (sub.plan_id !== meta.fromPlanId) return 'plan changed';
  if ((sub.pending_plan_id ?? null) !== meta.pendingPlanId) return 'pending plan changed';
  if (sub.cancel_at_period_end) return 'cancellation requested';
  return null;
}

/** Cancellation wins: a scheduled cancel is finalized instead of renewing (no charge, pending plan cleared). */
export async function finalizeCancellation(client: PoolClient, sub: SubscriptionRow, now: Date): Promise<void> {
  await client.query(
    `UPDATE subscriptions SET status = 'canceled', canceled_at = $2, cancel_reason = 'user_requested', pending_plan_id = NULL,
       past_due_since = NULL, next_retry_at = NULL, retry_count = 0, updated_at = $2
     WHERE id = $1`,
    [sub.id, now],
  );
  await insertEvent(client, {
    subscriptionId: sub.id,
    type: 'canceled',
    fromStatus: sub.status,
    toStatus: 'canceled',
    meta: {
      reason: 'user_requested',
      effective_at: (sub.status === 'past_due' && sub.past_due_since ? graceEndsAt(sub.past_due_since) : sub.current_period_end).toISOString(),
      cleared_pending_plan_id: sub.pending_plan_id,
      finalized_by: 'renewal_job',
    },
    at: now,
  });
}

export interface RollInput {
  toPlanId: string;
  pendingPlanId: string | null;
  periodStart: Date;
  periodEnd: Date;
  amountCents: number;
  trigger: 'renewal' | 'retry';
  invoiceId: string | null;
  operationId: string | null;
}

/**
 * Rolls the period forward (from the OLD period end), applies the pending plan, returns to `active` and clears every
 * past_due field, then writes `renewed` (+ `downgrade_applied`). Used for paid renewals (after the charge succeeded)
 * and for zero-price renewals (no provider call).
 */
export async function rollPeriod(client: PoolClient, sub: SubscriptionRow, r: RollInput, now: Date): Promise<void> {
  await client.query(
    `UPDATE subscriptions SET plan_id = $2, pending_plan_id = NULL, current_period_start = $3, current_period_end = $4,
       status = 'active', past_due_since = NULL, next_retry_at = NULL, retry_count = 0, updated_at = $5
     WHERE id = $1`,
    [sub.id, r.toPlanId, r.periodStart, r.periodEnd, now],
  );
  await insertEvent(client, {
    subscriptionId: sub.id,
    type: 'renewed',
    fromStatus: sub.status,
    toStatus: 'active',
    meta: {
      trigger: r.trigger,
      recovered_from_past_due: sub.status === 'past_due',
      from_plan_id: sub.plan_id,
      to_plan_id: r.toPlanId,
      amount_cents: r.amountCents,
      previous_period_end: sub.current_period_end.toISOString(),
      period_start: r.periodStart.toISOString(),
      period_end: r.periodEnd.toISOString(),
      invoice_id: r.invoiceId,
      operation_id: r.operationId,
    },
    at: now,
  });
  if (r.pendingPlanId) {
    await insertEvent(client, {
      subscriptionId: sub.id,
      type: 'downgrade_applied',
      fromStatus: 'active',
      toStatus: 'active',
      meta: { from_plan_id: sub.plan_id, to_plan_id: r.toPlanId, effective_at: r.periodStart.toISOString() },
      at: now,
    });
  }
}

/**
 * A definitive payment failure for a renewal attempt (docs/DECISIONS.md B19):
 *  - first failure (active): period NOT extended; enter past_due, grace starts now, first retry due in 1 day;
 *  - failed retry (past_due): count it; cancel with payment_failed after 3 failed retries or at/after the grace end;
 *    otherwise schedule the next retry anchored to past_due_since.
 */
export async function applyRenewalFailure(
  client: PoolClient,
  sub: SubscriptionRow,
  meta: RenewalMeta,
  now: Date,
  errorMessage: string,
  refs: { invoiceId: string | null; operationId: string; attempt: number },
): Promise<void> {
  const base = { trigger: meta.trigger, amount_cents: meta.amountCents, error: errorMessage, attempt: refs.attempt, invoice_id: refs.invoiceId, operation_id: refs.operationId };

  if (sub.status === 'active') {
    const next = new Date(now.getTime() + DAY_MS);
    await client.query(
      `UPDATE subscriptions SET status = 'past_due', past_due_since = $2, next_retry_at = $3, retry_count = 0, updated_at = $2 WHERE id = $1`,
      [sub.id, now, next],
    );
    await insertEvent(client, {
      subscriptionId: sub.id,
      type: 'renewal_failed',
      fromStatus: 'active',
      toStatus: 'past_due',
      meta: { ...base, retry_count: 0, past_due_since: now.toISOString(), grace_ends_at: graceEndsAt(now).toISOString(), next_retry_at: next.toISOString() },
      at: now,
    });
    return;
  }

  // past_due: this was a retry
  const since = sub.past_due_since!;
  const grace = graceEndsAt(since);
  const failedRetries = sub.retry_count + 1;
  if (failedRetries >= 3 || now.getTime() >= grace.getTime()) {
    await client.query(
      `UPDATE subscriptions SET status = 'canceled', canceled_at = $2, cancel_reason = 'payment_failed', pending_plan_id = NULL,
         past_due_since = NULL, next_retry_at = NULL, retry_count = 0, updated_at = $2 WHERE id = $1`,
      [sub.id, now],
    );
    await insertEvent(client, {
      subscriptionId: sub.id,
      type: 'renewal_failed',
      fromStatus: 'past_due',
      toStatus: 'past_due',
      meta: { ...base, retry_count: failedRetries, final: true },
      at: now,
    });
    await insertEvent(client, {
      subscriptionId: sub.id,
      type: 'canceled',
      fromStatus: 'past_due',
      toStatus: 'canceled',
      meta: {
        reason: 'payment_failed',
        retry_count: failedRetries,
        past_due_since: since.toISOString(),
        grace_ends_at: grace.toISOString(),
        cleared_pending_plan_id: sub.pending_plan_id,
        finalized_by: 'renewal_job',
      },
      at: now,
    });
    return;
  }
  const next = new Date(since.getTime() + (failedRetries + 1) * DAY_MS);
  await client.query('UPDATE subscriptions SET retry_count = $2, next_retry_at = $3, updated_at = $4 WHERE id = $1', [sub.id, failedRetries, next, now]);
  await insertEvent(client, {
    subscriptionId: sub.id,
    type: 'renewal_failed',
    fromStatus: 'past_due',
    toStatus: 'past_due',
    meta: { ...base, retry_count: failedRetries, grace_ends_at: grace.toISOString(), next_retry_at: next.toISOString() },
    at: now,
  });
}
