import type { Pool } from 'pg';

/**
 * Read-only views for the frontend (Stage 7). They expose existing tables to their OWNER only; nothing here changes
 * any state or billing behaviour.
 */

export interface UsageHistoryPeriod {
  periodStart: string;
  /** True for the subscription's current stored billing period. */
  isCurrent: boolean;
  metrics: { metric: string; used: number }[];
}

/** Per-period usage totals (most recent first). Counters are keyed by the stored period start. */
export async function getUsageHistory(deps: { pool: Pool }, userId: string, maxPeriods = 12): Promise<UsageHistoryPeriod[]> {
  const { rows } = await deps.pool.query<{ period_start: Date; metric: string; quantity: string; is_current: boolean }>(
    `SELECT ur.period_start, ur.metric, ur.quantity,
            (s.status <> 'canceled' AND ur.period_start = s.current_period_start) AS is_current
     FROM usage_records ur JOIN subscriptions s ON s.id = ur.subscription_id
     WHERE s.user_id = $1
     ORDER BY ur.period_start DESC, ur.metric
     LIMIT 500`,
    [userId],
  );
  const periods = new Map<string, UsageHistoryPeriod>();
  for (const r of rows) {
    const key = r.period_start.toISOString();
    let p = periods.get(key);
    if (!p) {
      if (periods.size >= maxPeriods) continue;
      p = { periodStart: key, isCurrent: r.is_current, metrics: [] };
      periods.set(key, p);
    }
    p.metrics.push({ metric: r.metric, used: Number(r.quantity) });
  }
  return [...periods.values()];
}

export interface OperationView {
  id: string;
  type: 'charge' | 'refund';
  /** pending = outcome not yet known (being confirmed with the provider); never presented as paid. */
  status: 'pending' | 'succeeded' | 'failed';
  kind: 'initial' | 'upgrade' | 'renewal' | 'other';
  amountCents: number;
  attempt: number;
  reason: string | null;
  errorMessage: string | null;
  invoiceId: string | null;
  refundOfOperationId: string | null;
  createdAt: string;
  updatedAt: string;
}

const kindOf = (obligationKey: string): OperationView['kind'] => {
  const prefix = obligationKey.split(':')[0];
  return prefix === 'initial' || prefix === 'upgrade' || prefix === 'renewal' ? prefix : 'other';
};

/** The caller's payment attempts and refunds, including pending ones and failed refunds (a diagnostic view). */
export async function listOperations(deps: { pool: Pool }, userId: string, limit = 100): Promise<OperationView[]> {
  const { rows } = await deps.pool.query<{
    id: string;
    operation_type: 'charge' | 'refund';
    status: OperationView['status'];
    obligation_key: string;
    amount_cents: number;
    attempt: number;
    reason: string | null;
    error_message: string | null;
    invoice_id: string | null;
    refund_of_operation_id: string | null;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT id, operation_type, status, obligation_key, amount_cents, attempt, reason, error_message, invoice_id,
            refund_of_operation_id, created_at, updated_at
     FROM billing_operations WHERE user_id = $1 ORDER BY created_at DESC, id LIMIT $2`,
    [userId, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    type: r.operation_type,
    status: r.status,
    kind: kindOf(r.obligation_key),
    amountCents: r.amount_cents,
    attempt: r.attempt,
    reason: r.reason,
    errorMessage: r.error_message,
    invoiceId: r.invoice_id,
    refundOfOperationId: r.refund_of_operation_id,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  }));
}
