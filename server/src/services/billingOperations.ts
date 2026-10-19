import type { Pool, PoolClient } from 'pg';
import type { BillingProvider, ChargeInput } from '../billing/provider';
import type { Clock } from '../lib/clock';
import { conflict } from '../lib/errors';

/**
 * Durable record of one payment attempt (table billing_operations). Two-phase pattern (docs/DECISIONS.md B7):
 *   Tx 1  allocateChargeAttempt()  -> pending row, committed BEFORE any provider call
 *   -     callProvider()           -> no transaction open
 *   Tx 2  settleCharge()           -> (chargeSettlement.ts) records the outcome and applies the state change
 */
export interface OperationRow {
  id: string;
  user_id: string;
  subscription_id: string | null;
  invoice_id: string | null;
  obligation_key: string;
  attempt: number;
  idempotency_key: string;
  operation_type: 'charge' | 'refund';
  refund_of_operation_id: string | null;
  reason: string | null;
  amount_cents: number;
  status: 'pending' | 'succeeded' | 'failed';
  provider_reference: string | null;
  error_message: string | null;
  meta: Record<string, unknown>;
  resolve_attempts: number;
  last_checked_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface BillingDeps {
  pool: Pool;
  clock: Clock;
  provider: BillingProvider;
  /** Provider calls slower than this are treated as an UNKNOWN outcome (never as a failure). */
  providerTimeoutMs: number;
}

export type ProviderOutcome =
  | { type: 'succeeded'; providerReference: string }
  | { type: 'failed'; errorCode: string; message: string }
  | { type: 'unknown' };

export type AllocateResult =
  | { kind: 'created'; op: OperationRow }
  | { kind: 'pending'; op: OperationRow }
  | { kind: 'already_succeeded'; op: OperationRow };

export const chargeKey = (obligationKey: string, attempt: number): string => `charge:${obligationKey}:attempt:${attempt}`;
export const refundKey = (obligationKey: string, attempt: number): string => `refund:${obligationKey}:attempt:${attempt}`;

export interface AllocateInput {
  userId: string;
  /** null for an initial subscription charge. */
  subscriptionId: string | null;
  obligationKey: string;
  amountCents: number;
  meta: Record<string, unknown>;
  now: Date;
}

/**
 * Tx 1 helper. The caller MUST already hold the subscription row lock (or the user row lock for an initial charge).
 *  - an unresolved (pending) attempt for this subscription/user blocks a new one: the caller must RESOLVE it, never mint a new key;
 *  - a succeeded attempt means the obligation is already collected;
 *  - a new attempt number is created ONLY after the previous attempt definitively failed.
 */
export async function allocateChargeAttempt(client: PoolClient, input: AllocateInput): Promise<AllocateResult> {
  const pendingQuery = input.subscriptionId
    ? client.query<OperationRow>(
        `SELECT * FROM billing_operations WHERE subscription_id = $1 AND operation_type = 'charge' AND status = 'pending' ORDER BY created_at LIMIT 1`,
        [input.subscriptionId],
      )
    : client.query<OperationRow>(
        `SELECT * FROM billing_operations WHERE user_id = $1 AND subscription_id IS NULL AND operation_type = 'charge' AND status = 'pending' ORDER BY created_at LIMIT 1`,
        [input.userId],
      );
  const pending = (await pendingQuery).rows[0];
  if (pending) return { kind: 'pending', op: pending };

  const { rows: history } = await client.query<OperationRow>(
    `SELECT * FROM billing_operations WHERE obligation_key = $1 AND operation_type = 'charge' ORDER BY attempt DESC`,
    [input.obligationKey],
  );
  // A succeeded charge whose effect was discarded (and refunded) does not count as collected.
  const { rows: refunds } = await client.query<{ refund_of_operation_id: string }>(
    `SELECT refund_of_operation_id FROM billing_operations WHERE obligation_key = $1 AND operation_type = 'refund'`,
    [input.obligationKey],
  );
  const refunded = new Set(refunds.map((r) => r.refund_of_operation_id));
  const succeeded = history.find((o) => o.status === 'succeeded' && !refunded.has(o.id));
  if (succeeded) return { kind: 'already_succeeded', op: succeeded };
  const attempt = (history[0]?.attempt ?? 0) + 1;

  try {
    const { rows } = await client.query<OperationRow>(
      `INSERT INTO billing_operations
         (user_id, subscription_id, obligation_key, attempt, idempotency_key, operation_type, amount_cents, status, meta, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'charge', $6, 'pending', $7::jsonb, $8, $8)
       RETURNING *`,
      [input.userId, input.subscriptionId, input.obligationKey, attempt, chargeKey(input.obligationKey, attempt), input.amountCents, JSON.stringify(input.meta), input.now],
    );
    return { kind: 'created', op: rows[0]! };
  } catch (err) {
    // The DB's partial unique index is the last line of defence against two in-flight attempts.
    if (isUniqueViolation(err)) throw conflict('OPERATION_IN_PROGRESS', 'A payment for this change is already being processed');
    throw err;
  }
}

/** Phase 2. Runs with NO transaction open. A thrown/timed-out call is an UNKNOWN outcome and is returned as such. */
export async function callProvider(deps: BillingDeps, input: ChargeInput): Promise<ProviderOutcome> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), deps.providerTimeoutMs);
    });
    const result = await Promise.race([deps.provider.charge(input), timeout]);
    if (result === 'timeout') return { type: 'unknown' };
    return result.status === 'succeeded'
      ? { type: 'succeeded', providerReference: result.providerReference }
      : { type: 'failed', errorCode: result.errorCode, message: result.message };
  } catch {
    return { type: 'unknown' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function getOperation(q: Pool | PoolClient, id: string): Promise<OperationRow | null> {
  const { rows } = await q.query<OperationRow>('SELECT * FROM billing_operations WHERE id = $1', [id]);
  return rows[0] ?? null;
}

export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === '23505';
}
