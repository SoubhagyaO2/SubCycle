import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ProviderUnavailableError, type BillingProvider } from '../src/billing/provider';
import type { Pool } from '../src/db/pool';
import type { ErrorBody } from '../src/lib/errors';
import { requestHash } from '../src/middleware/idempotency';
import { reconcilePendingOperations } from '../src/services/reconciliationService';
import type { HistoryEvent, InvoiceView, SubscriptionView } from '../src/services/subscriptionService';
import { createTestPool, resetData } from './helpers';
import { api, billingInvariantViolations, count, createHarness, DAY, planIds, signup, type Harness, type User } from './harness';

let pool: Pool;
let h: Harness;
let ids: Record<string, string>;
let alice: User;

beforeAll(() => {
  pool = createTestPool();
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await resetData(pool);
  h = createHarness(pool);
  ids = await planIds(pool);
  alice = await signup(h, 'alice@example.com');
});

const errOf = (res: request.Response) => (res.body as ErrorBody).error;
const subOf = (res: request.Response) => (res.body as { subscription: SubscriptionView }).subscription;
const subscribe = (u: User, code: string, headers: Record<string, string> = {}) => api(h, u).post('/subscriptions', { planId: ids[code] }, headers);
const upgrade = (u: User, code: string, headers: Record<string, string> = {}) => api(h, u).post('/subscriptions/upgrade', { planId: ids[code] }, headers);
const eventTypes = async (u: User) => ((await api(h, u).get('/subscriptions/history')).body as { events: HistoryEvent[] }).events.map((e) => e.type);
const invoicesOf = async (u: User) => ((await api(h, u).get('/invoices')).body as { invoices: InvoiceView[] }).invoices;
const currentPlan = async (u: User) => subOf(await api(h, u).get('/subscriptions/current')).plan.code;
const ops = async () =>
  (await pool.query('SELECT attempt, status, operation_type, idempotency_key, resolve_attempts, last_checked_at FROM billing_operations ORDER BY created_at, operation_type, attempt')).rows as {
    attempt: number;
    status: string;
    operation_type: string;
    idempotency_key: string;
    resolve_attempts: number;
    last_checked_at: Date | null;
  }[];
const reconcile = (olderThanMs = 0, deps = h.deps) => reconcilePendingOperations(deps, { olderThanMs });

/** Makes every invoice insert fail inside Tx 2, simulating a database failure AFTER the provider took the money. */
async function withFailingInvoiceInserts<T>(fn: () => Promise<T>): Promise<T> {
  await pool.query(`
    CREATE OR REPLACE FUNCTION fail_invoice_insert() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'injected database failure'; END $$ LANGUAGE plpgsql;
    CREATE TRIGGER fail_invoice_insert BEFORE INSERT ON invoices FOR EACH ROW EXECUTE FUNCTION fail_invoice_insert();`);
  try {
    return await fn();
  } finally {
    await pool.query('DROP TRIGGER fail_invoice_insert ON invoices; DROP FUNCTION fail_invoice_insert()');
  }
}

/** Free -> a period in which an upgrade to Pro costs a known amount. */
async function freeSubscriber(u = alice) {
  await subscribe(u, 'free');
  h.clock.advanceMs(10 * DAY);
}

describe('unknown outcomes are reconciled, never retried with a new key', () => {
  it('request dropped before reaching the provider: 409, attempt stays pending, reconciliation marks it failed, then a NEW attempt works', async () => {
    await freeSubscriber();
    h.provider.dropNextRequests();
    const res = await upgrade(alice, 'pro_monthly');
    expect(res.status).toBe(409);
    expect(errOf(res).code).toBe('OPERATION_IN_PROGRESS');
    expect(await currentPlan(alice)).toBe('free');
    expect((await ops()).map((o) => o.status)).toEqual(['pending']);

    // A user retry must NOT mint a new key while the attempt is unresolved.
    const again = await upgrade(alice, 'pro_monthly');
    expect(again.status).toBe(409);
    expect(await ops()).toHaveLength(1);
    expect(h.provider.processedCharges).toBe(0);

    const summary = await reconcile();
    expect(summary).toMatchObject({ examined: 1, declined: 1, applied: 0 });
    expect((await ops()).map((o) => [o.attempt, o.status])).toEqual([[1, 'failed']]);
    expect(await currentPlan(alice)).toBe('free');

    const retry = await upgrade(alice, 'pro_monthly');
    expect(retry.status).toBe(200);
    const all = await ops();
    expect(all.map((o) => [o.attempt, o.status])).toEqual([[1, 'failed'], [2, 'succeeded']]);
    expect(all[1]!.idempotency_key).toMatch(/:attempt:2$/);
    expect(h.provider.processedCharges).toBe(1);
    expect(await billingInvariantViolations(pool)).toEqual([]);
  });

  it('response lost AFTER the charge was taken: a retry resolves the SAME attempt via lookup; exactly one charge', async () => {
    await freeSubscriber();
    h.provider.loseNextResponses();
    const first = await upgrade(alice, 'pro_monthly');
    expect(first.status).toBe(409);
    expect(h.provider.processedCharges).toBe(1); // money was taken
    expect(await currentPlan(alice)).toBe('free'); // but we do not know yet
    expect((await ops()).map((o) => o.status)).toEqual(['pending']);

    const retry = await upgrade(alice, 'pro_monthly');
    expect(retry.status).toBe(200);
    expect(subOf(retry).plan.code).toBe('pro_monthly');
    expect(h.provider.processedCharges).toBe(1); // still one
    expect(h.provider.chargeCalls).toBe(1); // the retry did not even call charge()
    const all = await ops();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ attempt: 1, status: 'succeeded' });
    expect(await invoicesOf(alice)).toEqual([expect.objectContaining({ status: 'paid', amountCents: 33_803 })]);
    expect((await eventTypes(alice)).filter((t) => t === 'upgraded')).toHaveLength(1);
    expect(await billingInvariantViolations(pool)).toEqual([]);
  });

  it('response lost, no user retry: the reconciliation job applies the charge; running it again changes nothing', async () => {
    await freeSubscriber();
    h.provider.loseNextResponses();
    await upgrade(alice, 'pro_monthly');
    const summary = await reconcile();
    expect(summary).toMatchObject({ examined: 1, applied: 1 });
    expect(await currentPlan(alice)).toBe('pro_monthly');
    expect(await invoicesOf(alice)).toHaveLength(1);
    expect((await eventTypes(alice)).filter((t) => t === 'upgraded')).toHaveLength(1);
    expect(await reconcile()).toMatchObject({ examined: 0, applied: 0 });
    expect(h.provider.processedCharges).toBe(1);
    expect(await billingInvariantViolations(pool)).toEqual([]);
  });

  it('crash between phase 1 and phase 3 for an initial subscription: reconciliation creates the subscription exactly once', async () => {
    h.provider.loseNextResponses();
    const res = await subscribe(alice, 'pro_monthly');
    expect(res.status).toBe(409);
    expect(await count(pool, 'SELECT 1 FROM subscriptions')).toBe(0);
    expect(await reconcile()).toMatchObject({ applied: 1 });
    expect(await currentPlan(alice)).toBe('pro_monthly');
    expect(await count(pool, 'SELECT 1 FROM subscriptions')).toBe(1);
    const op = (await pool.query('SELECT subscription_id, invoice_id, status FROM billing_operations')).rows[0] as { subscription_id: string; invoice_id: string; status: string };
    expect(op.status).toBe('succeeded');
    expect(op.subscription_id).toBeTruthy(); // operation linked to the subscription created after activation
    expect(op.invoice_id).toBeTruthy();
    expect(h.provider.processedCharges).toBe(1);
  });

  it('concurrent reconcilers apply an operation exactly once', async () => {
    await freeSubscriber();
    h.provider.loseNextResponses();
    await upgrade(alice, 'pro_monthly');
    const runs = await Promise.all([reconcile(), reconcile(), reconcile()]);
    expect(runs.reduce((n, r) => n + r.applied, 0)).toBe(1);
    expect(await invoicesOf(alice)).toHaveLength(1);
    expect((await eventTypes(alice)).filter((t) => t === 'upgraded')).toHaveLength(1);
    expect(await billingInvariantViolations(pool)).toEqual([]);
  });

  it('leaves operations younger than the threshold alone', async () => {
    await freeSubscriber();
    h.provider.dropNextRequests();
    await upgrade(alice, 'pro_monthly');
    expect(await reconcile(5 * 60_000)).toMatchObject({ examined: 0 });
    expect((await ops())[0]!.status).toBe('pending');
    h.clock.advanceMs(6 * 60_000);
    expect(await reconcile(5 * 60_000)).toMatchObject({ examined: 1, declined: 1 });
  });

  it('a non-authoritative provider that returns "not found" keeps the attempt pending (no new key, no guess)', async () => {
    await freeSubscriber();
    h.provider.dropNextRequests();
    await upgrade(alice, 'pro_monthly');
    const cautious: BillingProvider = {
      lookupIsAuthoritative: false,
      charge: (i) => h.provider.charge(i),
      refund: (i) => h.provider.refund(i),
      lookup: (k) => h.provider.lookup(k),
    };
    const summary = await reconcile(0, { ...h.deps, provider: cautious });
    expect(summary).toMatchObject({ examined: 1, unresolved: 1, declined: 0 });
    const [op] = await ops();
    expect(op).toMatchObject({ status: 'pending', resolve_attempts: 1 });
    expect(op!.last_checked_at).not.toBeNull();
    expect((await upgrade(alice, 'pro_monthly')).status).toBe(409); // still no new attempt
    expect(await ops()).toHaveLength(1);
  });

  it('a failing provider lookup leaves the attempt pending for the next run', async () => {
    await freeSubscriber();
    h.provider.loseNextResponses();
    await upgrade(alice, 'pro_monthly');
    const broken: BillingProvider = { ...h.provider, lookupIsAuthoritative: true, charge: (i) => h.provider.charge(i), refund: (i) => h.provider.refund(i), lookup: () => Promise.reject(new ProviderUnavailableError()) };
    expect(await reconcile(0, { ...h.deps, provider: broken })).toMatchObject({ examined: 1, unresolved: 1, applied: 0 });
    expect((await ops())[0]).toMatchObject({ status: 'pending', resolve_attempts: 1 });
    expect(await reconcile()).toMatchObject({ applied: 1 }); // healthy provider: resolved
  });
});

describe('a successful charge followed by a database failure never causes a second charge', () => {
  it('upgrade: Tx 2 fails after the money was taken; the retry finds the SAME attempt and completes it', async () => {
    await freeSubscriber();
    await withFailingInvoiceInserts(async () => {
      const res = await upgrade(alice, 'pro_monthly');
      expect(res.status).toBe(500);
      expect(JSON.stringify(res.body)).not.toContain('injected');
    });
    expect(h.provider.processedCharges).toBe(1); // charged at the provider
    expect(await currentPlan(alice)).toBe('free'); // Tx 2 rolled back completely
    expect(await count(pool, 'SELECT 1 FROM invoices')).toBe(0);
    expect((await ops()).map((o) => o.status)).toEqual(['pending']);

    const retry = await upgrade(alice, 'pro_monthly');
    expect(retry.status).toBe(200);
    expect(h.provider.processedCharges).toBe(1);
    expect(h.provider.chargeCalls).toBe(1);
    expect(await ops()).toHaveLength(1);
    expect((await ops())[0]).toMatchObject({ attempt: 1, status: 'succeeded' });
    expect(await invoicesOf(alice)).toEqual([expect.objectContaining({ status: 'paid' })]);
    expect(await billingInvariantViolations(pool)).toEqual([]);
  });

  it('initial subscribe: same guarantee, and no half-created subscription is left behind', async () => {
    await withFailingInvoiceInserts(async () => {
      expect((await subscribe(alice, 'pro_monthly')).status).toBe(500);
    });
    expect(await count(pool, 'SELECT 1 FROM subscriptions')).toBe(0);
    expect(h.provider.processedCharges).toBe(1);
    const retry = await subscribe(alice, 'pro_monthly');
    expect(retry.status).toBe(201);
    expect(h.provider.processedCharges).toBe(1);
    expect(h.provider.chargeCalls).toBe(1);
    expect(await count(pool, 'SELECT 1 FROM subscriptions')).toBe(1);
    expect(await ops()).toHaveLength(1);
  });

  it('the reconciliation job can finish it instead of a retry', async () => {
    await freeSubscriber();
    await withFailingInvoiceInserts(async () => {
      await upgrade(alice, 'pro_monthly');
    });
    expect(await reconcile()).toMatchObject({ applied: 1 });
    expect(await currentPlan(alice)).toBe('pro_monthly');
    expect(h.provider.processedCharges).toBe(1);
  });

  it('a declined retry after a failed attempt keeps invoices and operations consistent', async () => {
    await freeSubscriber();
    h.provider.declineNext();
    await upgrade(alice, 'pro_monthly');
    h.provider.declineNext();
    h.clock.advanceMs(DAY);
    expect((await upgrade(alice, 'pro_monthly')).status).toBe(402);
    expect((await ops()).map((o) => [o.attempt, o.status])).toEqual([[1, 'failed'], [2, 'failed']]);
    expect(await invoicesOf(alice)).toEqual([expect.objectContaining({ status: 'failed' })]);
    expect(await billingInvariantViolations(pool)).toEqual([]);
  });
});

describe('concurrency', () => {

  it('simultaneous pause and cancel always resolve to one consistent state (20 rounds)', async () => {
    for (let i = 0; i < 20; i++) {
      const u = await signup(h, `race${i}@example.com`);
      await subscribe(u, 'free');
      const [pause, cancel] = await Promise.all([api(h, u).post('/subscriptions/pause'), api(h, u).post('/subscriptions/cancel')]);
      const row = (await pool.query('SELECT status, paused_at, cancel_at_period_end, cancel_requested_at FROM subscriptions WHERE user_id = $1', [u.userId])).rows[0] as {
        status: string;
        paused_at: Date | null;
        cancel_at_period_end: boolean;
        cancel_requested_at: Date | null;
      };
      expect(pause.status).toBe(200); // pause is valid in either order
      expect(row.status).toBe('paused');
      expect(row.paused_at).not.toBeNull();
      if (cancel.status === 200) {
        expect(row.cancel_at_period_end).toBe(true); // cancel won the race, pause then applied on top
      } else {
        expect(cancel.status).toBe(409); // pause won: cancel is rejected while paused
        expect(errOf(cancel).details).toMatchObject({ reason: 'cancel_while_paused' });
        expect(row.cancel_at_period_end).toBe(false);
        expect(row.cancel_requested_at).toBeNull();
      }
      const types = await eventTypes(u);
      expect(types.filter((t) => t === 'paused')).toHaveLength(1);
      expect(types.filter((t) => t === 'cancel_scheduled')).toHaveLength(cancel.status === 200 ? 1 : 0);
    }
  });

  it('simultaneous resumes extend the period once; simultaneous cancels schedule once', async () => {
    await subscribe(alice, 'free');
    await api(h, alice).post('/subscriptions/pause');
    h.clock.advanceMs(2 * DAY);
    const resumes = await Promise.all(Array.from({ length: 4 }, () => api(h, alice).post('/subscriptions/resume')));
    expect(resumes.filter((r) => r.status === 200)).toHaveLength(1);
    expect(subOf(await api(h, alice).get('/subscriptions/current')).currentPeriodEnd).toBe('2026-02-03T00:00:00.000Z');
    const cancels = await Promise.all(Array.from({ length: 4 }, () => api(h, alice).post('/subscriptions/cancel')));
    expect(cancels.filter((r) => r.status === 200)).toHaveLength(1);
    expect((await eventTypes(alice)).filter((t) => t === 'cancel_scheduled')).toHaveLength(1);
  });
});

describe('HTTP Idempotency-Key', () => {
  it('a repeated identical upgrade returns the original response and charges once', async () => {
    await freeSubscriber();
    const first = await upgrade(alice, 'pro_monthly', { 'Idempotency-Key': 'key-1' });
    expect(first.status).toBe(200);
    expect(first.headers['idempotent-replay']).toBeUndefined();
    const second = await upgrade(alice, 'pro_monthly', { 'Idempotency-Key': 'key-1' });
    expect(second.status).toBe(200);
    expect(second.headers['idempotent-replay']).toBe('true');
    expect(second.body).toEqual(first.body);
    expect(h.provider.processedCharges).toBe(1);
    expect(h.provider.chargeCalls).toBe(1);
    expect(await ops()).toHaveLength(1);
    expect((await eventTypes(alice)).filter((t) => t === 'upgraded')).toHaveLength(1);
    const key = (await pool.query('SELECT status, response_status FROM idempotency_keys')).rows;
    expect(key).toEqual([{ status: 'completed', response_status: 200 }]);
  });

  it('replays the original 201 for subscribe', async () => {
    const a = await subscribe(alice, 'pro_monthly', { 'Idempotency-Key': 'sub-1' });
    const b = await subscribe(alice, 'pro_monthly', { 'Idempotency-Key': 'sub-1' });
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(b.body).toEqual(a.body);
    expect(h.provider.processedCharges).toBe(1);
  });

  it('a stored 4xx (declined) is replayed for the same key; a new key makes a genuinely new attempt', async () => {
    await freeSubscriber();
    h.provider.declineNext();
    const a = await upgrade(alice, 'pro_monthly', { 'Idempotency-Key': 'pay-1' });
    expect(a.status).toBe(402);
    const b = await upgrade(alice, 'pro_monthly', { 'Idempotency-Key': 'pay-1' });
    expect(b.status).toBe(402);
    expect(b.headers['idempotent-replay']).toBe('true');
    expect(h.provider.chargeCalls).toBe(1);
    const c = await upgrade(alice, 'pro_monthly', { 'Idempotency-Key': 'pay-2' });
    expect(c.status).toBe(200);
    expect((await ops()).map((o) => [o.attempt, o.status])).toEqual([[1, 'failed'], [2, 'succeeded']]);
  });

  it('transient 409s are NOT stored: retrying with the same key resumes the work (one charge)', async () => {
    await freeSubscriber();
    h.provider.loseNextResponses();
    const a = await upgrade(alice, 'pro_monthly', { 'Idempotency-Key': 'lost-1' });
    expect(a.status).toBe(409);
    expect(await count(pool, 'SELECT 1 FROM idempotency_keys')).toBe(0);
    const b = await upgrade(alice, 'pro_monthly', { 'Idempotency-Key': 'lost-1' });
    expect(b.status).toBe(200);
    expect(b.headers['idempotent-replay']).toBeUndefined();
    expect(h.provider.processedCharges).toBe(1);
    expect(h.provider.chargeCalls).toBe(1);
  });

  it('5xx responses are NOT stored: after the fault clears, the same key works', async () => {
    await freeSubscriber();
    await withFailingInvoiceInserts(async () => {
      expect((await upgrade(alice, 'pro_monthly', { 'Idempotency-Key': 'boom-1' })).status).toBe(500);
    });
    expect(await count(pool, 'SELECT 1 FROM idempotency_keys')).toBe(0);
    const ok = await upgrade(alice, 'pro_monthly', { 'Idempotency-Key': 'boom-1' });
    expect(ok.status).toBe(200);
    expect(h.provider.processedCharges).toBe(1);
  });

  it('the same key with a different request is rejected (422), including a different endpoint', async () => {
    await subscribe(alice, 'business_monthly');
    expect((await api(h, alice).post('/subscriptions/downgrade', { planId: ids.pro_monthly }, { 'Idempotency-Key': 'k' })).status).toBe(200);
    const diffBody = await api(h, alice).post('/subscriptions/downgrade', { planId: ids.free }, { 'Idempotency-Key': 'k' });
    expect(diffBody.status).toBe(422);
    expect(errOf(diffBody).code).toBe('IDEMPOTENCY_KEY_REUSED');
    const diffPath = await api(h, alice).post('/subscriptions/pause', undefined, { 'Idempotency-Key': 'k' });
    expect(diffPath.status).toBe(422);
    expect(subOf(await api(h, alice).get('/subscriptions/current')).pendingPlan?.code).toBe('pro_monthly');
  });

  it('replays a repeated request whose body is the same', async () => {
    await subscribe(alice, 'business_monthly');
    const a = await api(h, alice).post('/subscriptions/cancel', { immediate: false }, { 'Idempotency-Key': 'eq' });
    const b = await api(h, alice).post('/subscriptions/cancel', { immediate: false }, { 'Idempotency-Key': 'eq' });
    expect([a.status, b.headers['idempotent-replay']]).toEqual([200, 'true']);
  });

  it('keys are scoped per user', async () => {
    const bob = await signup(h, 'bob@example.com');
    expect((await subscribe(alice, 'free', { 'Idempotency-Key': 'shared' })).status).toBe(201);
    const b = await subscribe(bob, 'free', { 'Idempotency-Key': 'shared' });
    expect(b.status).toBe(201);
    expect(b.headers['idempotent-replay']).toBeUndefined();
    expect(await count(pool, 'SELECT 1 FROM subscriptions')).toBe(2);
  });

  it('an abandoned in-progress request is taken over once its lock expires', async () => {
    await subscribe(alice, 'free');
    const hash = requestHash('POST', '/subscriptions/pause', undefined);
    await pool.query(
      `INSERT INTO idempotency_keys (user_id, key, request_method, request_path, request_hash, status, locked_until, expires_at)
       VALUES ($1, 'ab-1', 'POST', '/subscriptions/pause', $2, 'in_progress', $3, $4)`,
      [alice.userId, hash, new Date(h.clock.now().getTime() + 30_000), new Date(h.clock.now().getTime() + DAY)],
    );
    const blocked = await api(h, alice).post('/subscriptions/pause', undefined, { 'Idempotency-Key': 'ab-1' });
    expect(blocked.status).toBe(409);
    expect(errOf(blocked).code).toBe('REQUEST_IN_PROGRESS');

    h.clock.advanceMs(31_000); // the lock has expired: the original worker is presumed dead
    const taken = await api(h, alice).post('/subscriptions/pause', undefined, { 'Idempotency-Key': 'ab-1' });
    expect(taken.status).toBe(200);
    expect(subOf(taken).status).toBe('paused');
    const row = (await pool.query('SELECT status, response_status FROM idempotency_keys')).rows[0] as { status: string; response_status: number };
    expect(row).toEqual({ status: 'completed', response_status: 200 });
  });

  it('an expired key can be reused for a different request', async () => {
    await subscribe(alice, 'business_monthly');
    await pool.query(
      `INSERT INTO idempotency_keys (user_id, key, request_method, request_path, request_hash, status, locked_until, expires_at, response_status, response_body)
       VALUES ($1, 'old', 'POST', '/subscriptions/upgrade', 'other-hash', 'completed', $2, $2, 200, '{}'::jsonb)`,
      [alice.userId, new Date(h.clock.now().getTime() - 1000)],
    );
    const res = await api(h, alice).post('/subscriptions/pause', undefined, { 'Idempotency-Key': 'old' });
    expect(res.status).toBe(200);
  });

  it('rejects malformed keys with 400', async () => {
    await subscribe(alice, 'free');
    for (const bad of ['has space', 'x'.repeat(256), 'tab\there']) {
      const res = await api(h, alice).post('/subscriptions/pause', undefined, { 'Idempotency-Key': bad });
      expect(res.status, bad).toBe(400);
    }
  });

  it('requires authentication before looking at the key', async () => {
    const res = await request(h.app).post('/subscriptions/pause').set('Idempotency-Key', 'k');
    expect(res.status).toBe(401);
  });
});
