import type { PoolClient } from 'pg';
import { withTransaction } from '../db/transaction';
import { insertEvent, type SubscriptionRow } from '../db/subscriptionRepo';
import {
  getOperation,
  refundKey,
  type BillingDeps,
  type OperationRow,
  type ProviderOutcome,
} from './billingOperations';

/** Everything Tx 2 needs to apply a charge's effect later, even from the reconciler with no original request. */
export interface UpgradeMeta {
  kind: 'upgrade';
  fromPlanId: string;
  toPlanId: string;
  periodStart: string;
  periodEnd: string;
  amountCents: number;
  remainingMs: number;
  totalMs: number;
  computedAt: string;
  description: string;
}
export interface InitialMeta {
  kind: 'initial';
  planId: string;
  periodStart: string;
  periodEnd: string;
  description: string;
}
export type ChargeMeta = UpgradeMeta | InitialMeta;

export type SettleResult =
  /** Money collected AND the state change applied. */
  | { status: 'applied'; op: OperationRow; subscriptionId: string }
  /** Provider definitively declined; nothing changed except the audit records. */
  | { status: 'declined'; op: OperationRow }
  /** Money collected but the subscription no longer matched; compensation (refund) recorded, state unchanged. */
  | { status: 'discarded'; op: OperationRow; refundOperationId: string }
  /** Someone else (reconciler / a concurrent request) already settled it. */
  | { status: 'already_settled'; op: OperationRow; applied: boolean };

/**
 * Tx 2. Locks the parent row (subscription, or the user for an initial charge) and then the operation, re-validates
 * that the world still matches what justified the charge, and records the outcome. Idempotent: settling an already
 * settled operation is a no-op. Never calls the provider.
 */
export async function settleCharge(
  deps: Pick<BillingDeps, 'pool' | 'clock'>,
  opId: string,
  outcome: Exclude<ProviderOutcome, { type: 'unknown' }>,
): Promise<SettleResult> {
  return withTransaction(deps.pool, async (client) => {
    const peek = await getOperation(client, opId);
    if (!peek) throw new Error('billing operation not found');
    // Lock order: parent row first, then the operation row.
    if (peek.subscription_id) await client.query('SELECT id FROM subscriptions WHERE id = $1 FOR UPDATE', [peek.subscription_id]);
    else await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [peek.user_id]);
    const { rows } = await client.query<OperationRow>('SELECT * FROM billing_operations WHERE id = $1 FOR UPDATE', [opId]);
    const op = rows[0]!;
    if (op.status !== 'pending') return { status: 'already_settled', op, applied: await wasApplied(client, op) };

    const now = deps.clock.now();
    const meta = op.meta as unknown as ChargeMeta;

    if (outcome.type === 'failed') {
      const { rows: failed } = await client.query<OperationRow>(
        `UPDATE billing_operations SET status = 'failed', error_message = $2, updated_at = $3 WHERE id = $1 RETURNING *`,
        [op.id, `${outcome.errorCode}: ${outcome.message}`, now],
      );
      // A failed upgrade keeps a 'failed' invoice for audit (a later successful attempt flips it to paid).
      if (meta.kind === 'upgrade' && op.subscription_id) {
        const id = await upsertInvoice(client, { op, meta, status: 'failed', now });
        await client.query('UPDATE billing_operations SET invoice_id = $2 WHERE id = $1', [op.id, id]);
      }
      return { status: 'declined', op: failed[0]! };
    }

    const { rows: succeeded } = await client.query<OperationRow>(
      `UPDATE billing_operations SET status = 'succeeded', provider_reference = $2, error_message = NULL, updated_at = $3 WHERE id = $1 RETURNING *`,
      [op.id, outcome.providerReference, now],
    );
    const paidOp = succeeded[0]!;

    if (meta.kind === 'upgrade') {
      const sub = (await client.query<SubscriptionRow>('SELECT * FROM subscriptions WHERE id = $1', [op.subscription_id])).rows[0]!;
      const drift = upgradeDrift(sub, meta);
      if (drift) return discard(client, paidOp, drift, now, sub.id, sub.status);
      await applyUpgrade(client, sub, paidOp, meta, now);
      return { status: 'applied', op: paidOp, subscriptionId: sub.id };
    }

    const open = await client.query('SELECT id FROM subscriptions WHERE user_id = $1 AND status <> \'canceled\'', [op.user_id]);
    if (open.rowCount) return discard(client, paidOp, 'user already has a subscription', now, null, null);
    const subscriptionId = await applyInitial(client, paidOp, meta, now);
    return { status: 'applied', op: paidOp, subscriptionId };
  });
}

/** null when the subscription still matches the state the proration was computed against. */
function upgradeDrift(sub: SubscriptionRow, meta: UpgradeMeta): string | null {
  if (sub.status !== 'active') return `subscription is ${sub.status}`;
  if (sub.plan_id !== meta.fromPlanId) return 'plan changed';
  if (sub.current_period_start.getTime() !== new Date(meta.periodStart).getTime()) return 'billing period changed';
  return null;
}

async function discard(
  client: PoolClient,
  paidOp: OperationRow,
  reason: string,
  now: Date,
  subscriptionId: string | null,
  status: SubscriptionRow['status'] | null,
): Promise<SettleResult> {
  // Durable "compensation required" record. The provider refund itself happens AFTER this commit (processRefund).
  const { rows } = await client.query<OperationRow>(
    `INSERT INTO billing_operations
       (user_id, subscription_id, obligation_key, attempt, idempotency_key, operation_type, refund_of_operation_id,
        reason, amount_cents, status, meta, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'refund', $6, 'state_changed', $7, 'pending', $8::jsonb, $9, $9)
     RETURNING *`,
    [
      paidOp.user_id,
      paidOp.subscription_id,
      paidOp.obligation_key,
      paidOp.attempt,
      refundKey(paidOp.obligation_key, paidOp.attempt),
      paidOp.id,
      paidOp.amount_cents,
      JSON.stringify({ detail: reason }),
      now,
    ],
  );
  if (subscriptionId) {
    await insertEvent(client, {
      subscriptionId,
      type: 'charge_discarded',
      fromStatus: status,
      toStatus: status,
      meta: { operation_id: paidOp.id, refund_operation_id: rows[0]!.id, amount_cents: paidOp.amount_cents, reason },
      at: now,
    });
  }
  return { status: 'discarded', op: paidOp, refundOperationId: rows[0]!.id };
}

async function applyUpgrade(client: PoolClient, sub: SubscriptionRow, paidOp: OperationRow, meta: UpgradeMeta, now: Date): Promise<void> {
  const invoiceId = await upsertInvoice(client, { op: paidOp, meta, status: 'paid', now });
  await client.query('UPDATE billing_operations SET invoice_id = $2 WHERE id = $1', [paidOp.id, invoiceId]);
  await writeUpgrade(client, sub, meta, now, { invoiceId, operationId: paidOp.id });
}

/** Shared by the paid path (above) and the zero-amount path (no invoice, no provider call). */
export async function writeUpgrade(
  client: PoolClient,
  sub: SubscriptionRow,
  meta: Pick<UpgradeMeta, 'fromPlanId' | 'toPlanId' | 'periodStart' | 'periodEnd' | 'amountCents' | 'remainingMs' | 'totalMs'>,
  now: Date,
  refs: { invoiceId: string | null; operationId: string | null },
): Promise<void> {
  // Plan switch and clearing of the now-obsolete pending downgrade are ONE statement, hence atomic.
  await client.query('UPDATE subscriptions SET plan_id = $2, pending_plan_id = NULL, updated_at = $3 WHERE id = $1', [sub.id, meta.toPlanId, now]);
  if (sub.pending_plan_id) {
    await insertEvent(client, {
      subscriptionId: sub.id,
      type: 'downgrade_cleared',
      fromStatus: sub.status,
      toStatus: sub.status,
      meta: { reason: 'upgrade', cleared_pending_plan_id: sub.pending_plan_id },
      at: now,
    });
  }
  await insertEvent(client, {
    subscriptionId: sub.id,
    type: 'upgraded',
    fromStatus: sub.status,
    toStatus: sub.status,
    meta: {
      from_plan_id: meta.fromPlanId,
      to_plan_id: meta.toPlanId,
      amount_cents: meta.amountCents,
      remaining_ms: meta.remainingMs,
      total_ms: meta.totalMs,
      period_start: meta.periodStart,
      period_end: meta.periodEnd,
      cleared_pending_plan_id: sub.pending_plan_id,
      invoice_id: refs.invoiceId,
      operation_id: refs.operationId,
    },
    at: now,
  });
}

async function applyInitial(client: PoolClient, paidOp: OperationRow, meta: InitialMeta, now: Date): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO subscriptions (user_id, plan_id, status, current_period_start, current_period_end, created_at, updated_at)
     VALUES ($1, $2, 'active', $3, $4, $5, $5) RETURNING id`,
    [paidOp.user_id, meta.planId, meta.periodStart, meta.periodEnd, now],
  );
  const subscriptionId = rows[0]!.id;
  const withSub = { ...paidOp, subscription_id: subscriptionId };
  const invoiceId = await upsertInvoice(client, { op: withSub, meta, status: 'paid', now });
  // Link the operation to the subscription that now exists.
  await client.query('UPDATE billing_operations SET subscription_id = $2, invoice_id = $3 WHERE id = $1', [paidOp.id, subscriptionId, invoiceId]);
  await insertEvent(client, {
    subscriptionId,
    type: 'subscribed',
    fromStatus: null,
    toStatus: 'active',
    meta: {
      plan_id: meta.planId,
      amount_cents: paidOp.amount_cents,
      period_start: meta.periodStart,
      period_end: meta.periodEnd,
      invoice_id: invoiceId,
      operation_id: paidOp.id,
    },
    at: now,
  });
  return subscriptionId;
}

/** One invoice per billing obligation; a failed invoice may later become paid, a paid one is never downgraded. */
async function upsertInvoice(
  client: PoolClient,
  a: { op: OperationRow; meta: ChargeMeta; status: 'paid' | 'failed'; now: Date },
): Promise<string> {
  const kind = a.meta.kind === 'upgrade' ? 'upgrade_proration' : 'initial';
  const planId = a.meta.kind === 'upgrade' ? a.meta.toPlanId : a.meta.planId;
  await client.query(
    `INSERT INTO invoices (subscription_id, plan_id, obligation_key, kind, status, amount_cents, description, billing_period_start, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
     ON CONFLICT (obligation_key) DO UPDATE SET status = EXCLUDED.status, updated_at = EXCLUDED.updated_at
       WHERE invoices.status = 'failed'`,
    [a.op.subscription_id, planId, a.op.obligation_key, kind, a.status, a.op.amount_cents, a.meta.description, a.meta.periodStart, a.now],
  );
  const { rows } = await client.query<{ id: string }>('SELECT id FROM invoices WHERE obligation_key = $1', [a.op.obligation_key]);
  return rows[0]!.id;
}

async function wasApplied(client: PoolClient, op: OperationRow): Promise<boolean> {
  if (op.status !== 'succeeded') return false;
  const { rowCount } = await client.query(`SELECT 1 FROM billing_operations WHERE refund_of_operation_id = $1`, [op.id]);
  return !rowCount;
}

// ---- compensation refunds ---------------------------------------------------------------------------------------

/**
 * Processes one pending refund OUTSIDE any transaction (provider call), then records the result in a short Tx.
 * Safe to call repeatedly and concurrently: the provider call is idempotent on the refund's key and the recording
 * step re-checks the row under lock.
 */
export async function processRefund(deps: BillingDeps, refundOpId: string): Promise<'succeeded' | 'failed' | 'pending'> {
  const refund = await getOperation(deps.pool, refundOpId);
  if (!refund || refund.operation_type !== 'refund') throw new Error('refund operation not found');
  if (refund.status !== 'pending') return refund.status;
  const charge = refund.refund_of_operation_id ? await getOperation(deps.pool, refund.refund_of_operation_id) : null;
  if (!charge?.provider_reference) return 'pending'; // nothing to refund against yet

  let result;
  try {
    result = await deps.provider.refund({
      providerReference: charge.provider_reference,
      amountCents: refund.amount_cents,
      idempotencyKey: refund.idempotency_key,
    });
  } catch {
    return 'pending'; // unknown outcome: retried later with the SAME key
  }

  return withTransaction(deps.pool, async (client) => {
    const { rows } = await client.query<OperationRow>('SELECT * FROM billing_operations WHERE id = $1 FOR UPDATE', [refundOpId]);
    const current = rows[0]!;
    if (current.status !== 'pending') return current.status;
    const now = deps.clock.now();
    if (result.status === 'succeeded') {
      await client.query(
        `UPDATE billing_operations SET status = 'succeeded', provider_reference = $2, updated_at = $3 WHERE id = $1`,
        [refundOpId, result.providerReference, now],
      );
      if (charge.invoice_id) {
        await client.query(`UPDATE invoices SET status = 'refunded', updated_at = $2 WHERE id = $1 AND status = 'paid'`, [charge.invoice_id, now]);
      }
      return 'succeeded' as const;
    }
    await client.query(`UPDATE billing_operations SET status = 'failed', error_message = $2, updated_at = $3 WHERE id = $1`, [
      refundOpId,
      `${result.errorCode}: ${result.message}`,
      now,
    ]);
    return 'failed' as const;
  });
}

export async function processPendingRefunds(deps: BillingDeps, limit = 25): Promise<{ succeeded: number; failed: number; pending: number }> {
  const { rows } = await deps.pool.query<{ id: string }>(
    `SELECT id FROM billing_operations WHERE operation_type = 'refund' AND status = 'pending' ORDER BY created_at LIMIT $1`,
    [limit],
  );
  const tally = { succeeded: 0, failed: 0, pending: 0 };
  for (const { id } of rows) tally[await processRefund(deps, id)]++;
  return tally;
}
