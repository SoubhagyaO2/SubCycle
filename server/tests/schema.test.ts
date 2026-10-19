import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from '../src/db/pool';
import { createTestPool, insertSubscription, insertUser, planId, resetData } from './helpers';

let pool: Pool;
beforeEach(async () => {
  pool ??= createTestPool();
  await resetData(pool);
});
afterAll(async () => {
  await pool.end();
});

/** Asserts a query is rejected by the database with the given constraint/index name. */
async function expectViolation(promise: Promise<unknown>, constraint: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ constraint });
}

describe('users', () => {
  it('rejects non-lowercase email and duplicates', async () => {
    await expectViolation(
      pool.query(`INSERT INTO users (email, password_hash, name) VALUES ('A@Example.com', 'x', 'n')`),
      'users_email_lowercase',
    );
    await insertUser(pool, 'a@example.com');
    await expectViolation(insertUser(pool, 'a@example.com'), 'users_email_unique');
  });
});

describe('plans', () => {
  it('rejects negative price, bad interval, non-object limits, duplicate code', async () => {
    const ins = (code: string, price: number, interval: string, limits: string) =>
      pool.query(`INSERT INTO plans (code, name, price_cents, interval, limits) VALUES ($1, 'n', $2, $3, $4::jsonb)`, [code, price, interval, limits]);
    await expectViolation(ins('x1', -1, 'month', '{}'), 'plans_price_nonnegative');
    await expectViolation(ins('x2', 1, 'week', '{}'), 'plans_interval_valid');
    await expectViolation(ins('x3', 1, 'month', '[1]'), 'plans_limits_is_object');
    await expectViolation(ins('free', 0, 'month', '{}'), 'plans_code_unique');
  });
});

describe('subscriptions', () => {
  it('allows only one non-canceled subscription per user, but keeps canceled history', async () => {
    const u = await insertUser(pool);
    await insertSubscription(pool, u, 'free');
    await expectViolation(insertSubscription(pool, u, 'pro_monthly'), 'subscriptions_one_open_per_user');
    await expectViolation(insertSubscription(pool, u, 'pro_monthly', { status: 'paused', extra: { paused_at: '2026-01-02T00:00:00Z' } }), 'subscriptions_one_open_per_user');

    const u2 = await insertUser(pool, 'b@example.com');
    const canceled = { status: 'canceled', extra: { canceled_at: '2026-01-10T00:00:00Z', cancel_reason: 'user_requested' } };
    await insertSubscription(pool, u2, 'free', canceled);
    await insertSubscription(pool, u2, 'free', canceled); // multiple canceled rows are fine
    await insertSubscription(pool, u2, 'pro_monthly'); // and a new open one after cancellation
  });

  it('enforces period order, status values, retry range and pending-plan difference', async () => {
    const u = await insertUser(pool);
    await expectViolation(insertSubscription(pool, u, 'free', { start: '2026-02-01T00:00:00Z', end: '2026-02-01T00:00:00Z' }), 'subscriptions_period_order');
    await expectViolation(insertSubscription(pool, u, 'free', { status: 'trialing' }), 'subscriptions_status_valid');
    await expectViolation(
      insertSubscription(pool, u, 'free', { status: 'past_due', extra: { past_due_since: '2026-02-01T00:00:00Z', retry_count: 4 } }),
      'subscriptions_retry_count_range',
    );
    await expectViolation(insertSubscription(pool, u, 'free', { extra: { pending_plan_id: await planId(pool, 'free') } }), 'subscriptions_pending_differs');
  });

  it('keeps status-dependent fields consistent', async () => {
    const u = await insertUser(pool);
    await expectViolation(insertSubscription(pool, u, 'free', { status: 'paused' }), 'subscriptions_paused_at_iff_paused');
    await expectViolation(insertSubscription(pool, u, 'free', { extra: { paused_at: '2026-01-02T00:00:00Z' } }), 'subscriptions_paused_at_iff_paused');
    await expectViolation(insertSubscription(pool, u, 'free', { status: 'past_due' }), 'subscriptions_past_due_since_iff_past_due');
    await expectViolation(insertSubscription(pool, u, 'free', { status: 'canceled' }), 'subscriptions_canceled_fields');
    await expectViolation(insertSubscription(pool, u, 'free', { extra: { next_retry_at: '2026-01-02T00:00:00Z' } }), 'subscriptions_retry_fields_only_past_due');
    await expectViolation(insertSubscription(pool, u, 'free', { extra: { cancel_at_period_end: true } }), 'subscriptions_cancel_flag_has_request');
    await expectViolation(
      insertSubscription(pool, u, 'free', { status: 'canceled', extra: { canceled_at: '2026-01-10T00:00:00Z', cancel_reason: 'because' } }),
      'subscriptions_cancel_reason_valid',
    );
    // a valid delinquent subscription with a user-requested cancel is representable
    await insertSubscription(pool, u, 'pro_monthly', {
      status: 'past_due',
      extra: { past_due_since: '2026-02-01T00:00:00Z', next_retry_at: '2026-02-02T00:00:00Z', retry_count: 1, cancel_at_period_end: true, cancel_requested_at: '2026-02-01T12:00:00Z' },
    });
  });

  it('references real users and plans', async () => {
    await expect(
      pool.query(`INSERT INTO subscriptions (user_id, plan_id, status, current_period_start, current_period_end)
                  VALUES (gen_random_uuid(), gen_random_uuid(), 'active', now(), now() + interval '1 day')`),
    ).rejects.toMatchObject({ code: '23503' });
  });
});

describe('invoices and billing_operations', () => {
  async function setup() {
    const u = await insertUser(pool);
    const s = await insertSubscription(pool, u, 'pro_monthly');
    const p = await planId(pool, 'pro_monthly');
    return { u, s, p };
  }
  const invoice = (pool_: Pool, s: string, p: string, obligation: string, kind: string, period: string, amount = 100) =>
    pool_.query(
      `INSERT INTO invoices (subscription_id, plan_id, obligation_key, kind, status, amount_cents, description, billing_period_start)
       VALUES ($1, $2, $3, $4, 'paid', $5, 'd', $6)`,
      [s, p, obligation, kind, amount, period],
    );
  const op = (u: string, s: string | null, obligation: string, attempt: number, extra: { key?: string; type?: string; refundOf?: string | null; status?: string } = {}) =>
    pool.query(
      `INSERT INTO billing_operations (user_id, subscription_id, obligation_key, attempt, idempotency_key, operation_type, refund_of_operation_id, amount_cents, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 100, $8)`,
      [u, s, obligation, attempt, extra.key ?? `charge:${obligation}:attempt:${attempt}`, extra.type ?? 'charge', extra.refundOf ?? null, extra.status ?? 'pending'],
    );

  it('never invoices zero amounts, and each obligation at most once', async () => {
    const { s, p } = await setup();
    await expectViolation(invoice(pool, s, p, 'ob0', 'renewal', '2026-02-01T00:00:00Z', 0), 'invoices_amount_positive');
    await invoice(pool, s, p, 'ob1', 'upgrade_proration', '2026-01-01T00:00:00Z');
    await expectViolation(invoice(pool, s, p, 'ob1', 'upgrade_proration', '2026-01-01T00:00:00Z'), 'invoices_obligation_key_unique');
    // two different upgrade obligations in the same period are allowed
    await invoice(pool, s, p, 'ob2', 'upgrade_proration', '2026-01-01T00:00:00Z');
  });

  it('allows a renewal for a period only once', async () => {
    const { s, p } = await setup();
    await invoice(pool, s, p, 'renewal:a', 'renewal', '2026-02-01T00:00:00Z');
    await expectViolation(invoice(pool, s, p, 'renewal:b', 'renewal', '2026-02-01T00:00:00Z'), 'invoices_one_renewal_per_period');
    await invoice(pool, s, p, 'renewal:c', 'renewal', '2026-03-01T00:00:00Z');
  });

  it('enforces idempotency-key and attempt uniqueness, and one pending charge per obligation', async () => {
    const { u, s } = await setup();
    await op(u, s, 'ob', 1, { status: 'failed' });
    await expectViolation(op(u, s, 'ob', 1, { key: 'other-key' }), 'billing_operations_attempt_unique');
    await expectViolation(op(u, s, 'ob2', 1, { key: 'charge:ob:attempt:1' }), 'billing_operations_idempotency_key_unique');
    await op(u, s, 'ob', 2); // new attempt after a definitive failure
    await expectViolation(op(u, s, 'ob', 3), 'billing_operations_one_pending_charge'); // a second in-flight attempt is impossible
  });

  it('supports an initial charge with no subscription yet, and links compensation refunds one-to-one', async () => {
    const { u, s } = await setup();
    await op(u, null, 'initial:1', 1);
    const { rows } = await pool.query<{ id: string }>(`SELECT id FROM billing_operations WHERE obligation_key = 'initial:1'`);
    const chargeId = rows[0]!.id;
    await expectViolation(op(u, s, 'initial:1', 1, { type: 'refund' }), 'billing_operations_refund_link'); // refund must reference a charge
    await op(u, s, 'initial:1', 1, { type: 'refund', key: 'refund:initial:1:attempt:1', refundOf: chargeId });
    await expectViolation(
      op(u, s, 'initial:1', 2, { type: 'refund', key: 'refund:initial:1:attempt:2', refundOf: chargeId }),
      'billing_operations_one_refund_per_charge',
    );
    await expectViolation(op(u, s, 'x', 1, { refundOf: chargeId }), 'billing_operations_refund_link'); // a charge cannot reference a refund target
  });
});

describe('subscription_events, usage_records, idempotency_keys', () => {
  it('only accepts the defined event types', async () => {
    const s = await insertSubscription(pool, await insertUser(pool), 'free');
    const ev = (type: string) => pool.query(`INSERT INTO subscription_events (subscription_id, type, created_at) VALUES ($1, $2, now())`, [s, type]);
    for (const t of ['subscribed', 'upgraded', 'downgrade_scheduled', 'downgrade_cleared', 'downgrade_applied', 'paused', 'resumed', 'cancel_scheduled', 'reactivated', 'renewed', 'renewal_failed', 'canceled']) {
      await ev(t);
    }
    await expectViolation(ev('exploded'), 'subscription_events_type_valid');
  });

  it('increments usage atomically under concurrency and rejects negative quantity', async () => {
    const s = await insertSubscription(pool, await insertUser(pool), 'free');
    const inc = () =>
      pool.query(
        `INSERT INTO usage_records (subscription_id, metric, period_start, quantity)
         VALUES ($1, 'api_calls', '2026-01-01T00:00:00Z', 1)
         ON CONFLICT (subscription_id, metric, period_start)
         DO UPDATE SET quantity = usage_records.quantity + 1`,
        [s],
      );
    await Promise.all(Array.from({ length: 50 }, inc));
    const { rows } = await pool.query<{ quantity: string; n: string }>(
      `SELECT max(quantity) AS quantity, count(*) AS n FROM usage_records WHERE subscription_id = $1`,
      [s],
    );
    expect(rows[0]).toEqual({ quantity: '50', n: '1' });
    await expectViolation(
      pool.query(`INSERT INTO usage_records (subscription_id, metric, period_start, quantity) VALUES ($1, 'seats', now(), -1)`, [s]),
      'usage_records_quantity_nonnegative',
    );
  });

  it('enforces idempotency key uniqueness per user (not globally)', async () => {
    const u1 = await insertUser(pool, 'a@example.com');
    const u2 = await insertUser(pool, 'b@example.com');
    const ins = (u: string, status = 'in_progress', resp: number | null = null) =>
      pool.query(
        `INSERT INTO idempotency_keys (user_id, key, request_method, request_path, request_hash, status, locked_until, expires_at, response_status)
         VALUES ($1, 'k1', 'POST', '/subscriptions/upgrade', 'h', $2, now() + interval '1 minute', now() + interval '1 day', $3)`,
        [u, status, resp],
      );
    await ins(u1);
    await expectViolation(ins(u1), 'idempotency_keys_user_key_unique');
    await ins(u2);
    await expectViolation(ins(u2), 'idempotency_keys_user_key_unique');
  });

  it('requires a response for completed idempotency keys', async () => {
    const u = await insertUser(pool);
    await expectViolation(
      pool.query(
        `INSERT INTO idempotency_keys (user_id, key, request_method, request_path, request_hash, status, locked_until, expires_at)
         VALUES ($1, 'k2', 'POST', '/x', 'h', 'completed', now(), now())`,
        [u],
      ),
      'idempotency_keys_completed_has_response',
    );
  });
});
