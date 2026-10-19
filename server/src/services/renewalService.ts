import { addInterval } from '../lib/periods';
import { getPlan, type SubscriptionRow } from '../db/subscriptionRepo';
import { withTransaction } from '../db/transaction';
import { allocateChargeAttempt, callProvider, type AllocateResult, type BillingDeps } from './billingOperations';
import { processRefund, settleCharge, type RenewalMeta, type SettleResult } from './chargeSettlement';
import { reconcilePendingOperations, type ReconcileSummary } from './reconciliationService';
import { finalizeCancellation, rollPeriod } from './renewalApply';

/** Renewal / retry job for ONE subscription. Rules and rationale: docs/DECISIONS.md B19. */
export type RenewalOutcome =
  | 'not_due' // nothing to do (not due, or already processed by an earlier/concurrent run)
  | 'locked' // another worker or a user action holds the row: skipped, not waited on
  | 'renewed' // period rolled (paid, or free / zero-price)
  | 'canceled' // scheduled cancellation finalized, no charge
  | 'declined' // provider declined; subscription moved to past_due / retry scheduled / canceled (payment_failed)
  | 'discarded' // charge succeeded but state changed mid-flight: refunded, next run re-evaluates
  | 'in_progress' // an earlier attempt has no known outcome yet: resolved by lookup / reconciliation, never re-charged
  | 'resolved_pending'; // finalized somebody else's earlier unresolved attempt

type Tx1 =
  | { kind: 'done'; outcome: RenewalOutcome }
  | { kind: 'charge'; alloc: AllocateResult; obligationKey: string; chargeInput: { amountCents: number; userId: string; subscriptionId: string; description: string } };

const dueTrigger = (sub: SubscriptionRow, now: Date): 'renewal' | 'retry' | null => {
  if (sub.status === 'active' && sub.current_period_end.getTime() <= now.getTime()) return 'renewal';
  if (sub.status === 'past_due' && sub.next_retry_at && sub.next_retry_at.getTime() <= now.getTime()) return 'retry';
  return null;
};

export async function processSubscription(deps: BillingDeps, subscriptionId: string): Promise<RenewalOutcome> {
  // ---- Tx 1: claim (SKIP LOCKED), re-validate due-ness, decide, record the pending attempt, COMMIT ----
  const tx1 = await withTransaction<Tx1>(deps.pool, async (client) => {
    const { rows } = await client.query<SubscriptionRow>('SELECT * FROM subscriptions WHERE id = $1 FOR UPDATE SKIP LOCKED', [subscriptionId]);
    const sub = rows[0];
    if (!sub) {
      const exists = await client.query('SELECT 1 FROM subscriptions WHERE id = $1', [subscriptionId]);
      return { kind: 'done', outcome: exists.rowCount ? 'locked' : 'not_due' };
    }
    const now = deps.clock.now();
    const trigger = dueTrigger(sub, now);
    if (!trigger) return { kind: 'done', outcome: 'not_due' };

    // 1. Cancellation wins over everything (including a pending downgrade): finalize, never charge.
    if (sub.cancel_at_period_end) {
      await finalizeCancellation(client, sub, now);
      return { kind: 'done', outcome: 'canceled' };
    }

    // 2. The plan for the next period: the pending downgrade if set, else the current plan.
    const nextPlan = (await getPlan(client, sub.pending_plan_id ?? sub.plan_id))!;
    const periodStart = sub.current_period_end; // roll from the OLD end, never from now
    const periodEnd = addInterval(periodStart, nextPlan.interval);

    // 3. Zero price: roll, apply the pending plan, no provider call, no invoice.
    if (nextPlan.price_cents === 0) {
      await rollPeriod(client, sub, { toPlanId: nextPlan.id, pendingPlanId: sub.pending_plan_id, periodStart, periodEnd, amountCents: 0, trigger, invoiceId: null, operationId: null }, now);
      return { kind: 'done', outcome: 'renewed' };
    }

    // 4. Paid: durable pending attempt first, provider call after commit.
    const obligationKey = `renewal:${sub.id}:${periodStart.toISOString()}`;
    const meta: RenewalMeta = {
      kind: 'renewal',
      trigger,
      fromPlanId: sub.plan_id,
      toPlanId: nextPlan.id,
      pendingPlanId: sub.pending_plan_id,
      oldPeriodEnd: periodStart.toISOString(),
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      amountCents: nextPlan.price_cents,
      description: `${nextPlan.name} renewal`,
    };
    const alloc = await allocateChargeAttempt(client, {
      userId: sub.user_id,
      subscriptionId: sub.id,
      obligationKey,
      amountCents: nextPlan.price_cents,
      meta: meta as unknown as Record<string, unknown>,
      now,
    });
    return { kind: 'charge', alloc, obligationKey, chargeInput: { amountCents: nextPlan.price_cents, userId: sub.user_id, subscriptionId: sub.id, description: meta.description } };
  });

  if (tx1.kind === 'done') return tx1.outcome;

  switch (tx1.alloc.kind) {
    case 'already_succeeded':
      // The obligation was already collected AND applied (otherwise the row would no longer be due): nothing to do.
      return 'not_due';

    case 'created': {
      // Phase 2: NO transaction open. An unknown outcome leaves the attempt pending for lookup/reconciliation.
      const outcome = await callProvider(deps, { ...tx1.chargeInput, idempotencyKey: tx1.alloc.op.idempotency_key });
      if (outcome.type === 'unknown') return 'in_progress';
      return finish(deps, await settleCharge(deps, tx1.alloc.op.id, outcome));
    }

    case 'pending': {
      // An earlier attempt never reached its outcome. Resolve THAT attempt via its original key; never create a new one.
      let found;
      try {
        found = await deps.provider.lookup(tx1.alloc.op.idempotency_key);
      } catch {
        return 'in_progress';
      }
      if (!found) return 'in_progress'; // still in flight, or the reconciler decides
      const settled = await settleCharge(
        deps,
        tx1.alloc.op.id,
        found.status === 'succeeded'
          ? { type: 'succeeded', providerReference: found.providerReference ?? '' }
          : { type: 'failed', errorCode: found.errorCode ?? 'declined', message: found.message ?? 'Declined by provider' },
      );
      const mapped = await finish(deps, settled);
      return tx1.alloc.op.obligation_key === tx1.obligationKey ? mapped : 'resolved_pending';
    }
  }
}

/**
 * Maps a settled attempt to an outcome. A discarded charge has a durable pending refund; it is processed right away,
 * OUTSIDE any transaction (the reconciliation job retries it if that attempt is unknown).
 */
async function finish(deps: BillingDeps, result: SettleResult): Promise<RenewalOutcome> {
  if (result.status === 'discarded') {
    try {
      await processRefund(deps, result.refundOperationId);
    } catch {
      /* recovered by the next job cycle */
    }
  }
  return mapSettle(result);
}

function mapSettle(result: SettleResult): RenewalOutcome {
  switch (result.status) {
    case 'applied':
      return 'renewed';
    case 'declined':
      return 'declined';
    case 'discarded':
      return 'discarded';
    case 'already_settled':
      return result.op.status === 'failed' ? 'declined' : result.applied ? 'renewed' : 'discarded';
  }
}

export interface RenewalSummary {
  examined: number;
  outcomes: Record<RenewalOutcome, number>;
  errors: { subscriptionId: string; error: string }[];
}

const emptyOutcomes = (): Record<RenewalOutcome, number> => ({
  not_due: 0,
  locked: 0,
  renewed: 0,
  canceled: 0,
  declined: 0,
  discarded: 0,
  in_progress: 0,
  resolved_pending: 0,
});

/** Finds due subscriptions and processes each independently, so one failure never blocks the batch. */
export async function runRenewals(deps: BillingDeps, opts: { batchSize?: number } = {}): Promise<RenewalSummary> {
  const now = deps.clock.now();
  const { rows } = await deps.pool.query<{ id: string }>(
    `SELECT id FROM subscriptions
     WHERE (status = 'active' AND current_period_end <= $1) OR (status = 'past_due' AND next_retry_at <= $1)
     ORDER BY COALESCE(next_retry_at, current_period_end), id
     LIMIT $2`,
    [now, opts.batchSize ?? 100],
  );
  const summary: RenewalSummary = { examined: rows.length, outcomes: emptyOutcomes(), errors: [] };
  for (const { id } of rows) {
    try {
      summary.outcomes[await processSubscription(deps, id)]++;
    } catch (err) {
      // Isolated: record and continue. (Message only; never request data or secrets.)
      summary.errors.push({ subscriptionId: id, error: err instanceof Error ? err.message : 'unknown error' });
    }
  }
  return summary;
}

export interface JobCycleSummary {
  reconciliation: ReconcileSummary;
  renewals: RenewalSummary;
  /** Expired HTTP idempotency records removed (housekeeping; keeps the table bounded). */
  purgedIdempotencyKeys: number;
}

/** Deletes HTTP idempotency records past their 24 h expiry. They are never needed again: an expired key is reusable anyway. */
export async function purgeExpiredIdempotencyKeys(deps: Pick<BillingDeps, 'pool' | 'clock'>): Promise<number> {
  const { rowCount } = await deps.pool.query('DELETE FROM idempotency_keys WHERE expires_at <= $1', [deps.clock.now()]);
  return rowCount ?? 0;
}

/** One scheduler tick: first recover unresolved money movements, then renew. Safe to run repeatedly and concurrently. */
export async function runJobCycle(deps: BillingDeps, opts: { reconcileAfterMs: number; batchSize?: number }): Promise<JobCycleSummary> {
  const reconciliation = await reconcilePendingOperations(deps, { olderThanMs: opts.reconcileAfterMs });
  const renewals = await runRenewals(deps, opts.batchSize === undefined ? {} : { batchSize: opts.batchSize });
  const purgedIdempotencyKeys = await purgeExpiredIdempotencyKeys(deps);
  return { reconciliation, renewals, purgedIdempotencyKeys };
}
