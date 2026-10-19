import { getOperation, type BillingDeps, type OperationRow } from './billingOperations';
import { processPendingRefunds, settleCharge, type SettleResult } from './chargeSettlement';

export interface ReconcileSummary {
  examined: number;
  applied: number;
  declined: number;
  discarded: number;
  alreadySettled: number;
  /** Provider could not say (or is not authoritative): left pending, retried next run, never given a new key. */
  unresolved: number;
  refunds: { succeeded: number; failed: number; pending: number };
}

/**
 * Resolves charge operations stuck in `pending` (crash between phases, lost response, timeout) by asking the provider
 * about the EXISTING idempotency key. It never creates a new attempt. Cron wiring comes with the jobs stage.
 *
 * Concurrency: candidates are listed without locks; the claim happens inside settleCharge, which locks the parent row
 * and the operation and re-checks `status = 'pending'`, so two reconcilers (or a reconciler and a user retry) can
 * run together without double-applying.
 */
export async function reconcilePendingOperations(
  deps: BillingDeps,
  opts: { olderThanMs: number; limit?: number },
): Promise<ReconcileSummary> {
  const cutoff = new Date(deps.clock.now().getTime() - opts.olderThanMs);
  const { rows } = await deps.pool.query<{ id: string }>(
    `SELECT id FROM billing_operations
     WHERE operation_type = 'charge' AND status = 'pending' AND created_at <= $1
     ORDER BY created_at LIMIT $2`,
    [cutoff, opts.limit ?? 50],
  );

  const summary: ReconcileSummary = { examined: 0, applied: 0, declined: 0, discarded: 0, alreadySettled: 0, unresolved: 0, refunds: { succeeded: 0, failed: 0, pending: 0 } };
  for (const { id } of rows) {
    const op = await getOperation(deps.pool, id);
    if (op?.status !== 'pending') continue;
    summary.examined++;
    const result = await reconcileOne(deps, op);
    if (!result) summary.unresolved++;
    else if (result.status === 'applied') summary.applied++;
    else if (result.status === 'declined') summary.declined++;
    else if (result.status === 'discarded') summary.discarded++;
    else summary.alreadySettled++;
  }
  summary.refunds = await processPendingRefunds(deps);
  return summary;
}

async function reconcileOne(deps: BillingDeps, op: OperationRow): Promise<SettleResult | null> {
  let found;
  try {
    found = await deps.provider.lookup(op.idempotency_key);
  } catch {
    await touch(deps, op);
    return null;
  }
  if (found) {
    return settleCharge(
      deps,
      op.id,
      found.status === 'succeeded'
        ? { type: 'succeeded', providerReference: found.providerReference ?? '' }
        : { type: 'failed', errorCode: found.errorCode ?? 'declined', message: found.message ?? 'Declined by provider' },
    );
  }
  if (deps.provider.lookupIsAuthoritative) {
    // The provider has definitively never seen this attempt: it did not and will not happen.
    return settleCharge(deps, op.id, { type: 'failed', errorCode: 'not_found_at_provider', message: 'The provider has no record of this attempt' });
  }
  await touch(deps, op);
  return null;
}

async function touch(deps: BillingDeps, op: OperationRow): Promise<void> {
  await deps.pool.query(
    `UPDATE billing_operations SET resolve_attempts = resolve_attempts + 1, last_checked_at = $2 WHERE id = $1 AND status = 'pending'`,
    [op.id, deps.clock.now()],
  );
}
