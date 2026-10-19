/**
 * Deterministic replacements for the earlier sleep-based concurrency tests.
 *
 * Technique: `provider.holdNextCharge()` returns a gate. The next charge() call parks INSIDE the provider until
 * `gate.release()`. `await gate.entered` therefore proves the request is mid-charge (phase 1 committed, phase 3 not
 * started) with no sleeping. Tests that start requests "simultaneously" assert only order-independent invariants.
 */
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ProviderUnavailableError } from '../src/billing/provider';
import type { Pool } from '../src/db/pool';
import type { ErrorBody } from '../src/lib/errors';
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

const started = (t: request.Test): Promise<request.Response> => t.then((r) => r);
const errOf = (res: request.Response) => (res.body as ErrorBody).error;
const subOf = (res: request.Response) => (res.body as { subscription: SubscriptionView }).subscription;
const subscribe = (u: User, code: string, headers: Record<string, string> = {}) => api(h, u).post('/subscriptions', { planId: ids[code] }, headers);
const upgrade = (u: User, code: string, headers: Record<string, string> = {}) => api(h, u).post('/subscriptions/upgrade', { planId: ids[code] }, headers);
const eventTypes = async (u: User) => ((await api(h, u).get('/subscriptions/history')).body as { events: HistoryEvent[] }).events.map((e) => e.type);
const invoicesOf = async (u: User) => ((await api(h, u).get('/invoices')).body as { invoices: InvoiceView[] }).invoices;
const currentPlan = async (u: User) => subOf(await api(h, u).get('/subscriptions/current')).plan.code;
const opRows = async () => (await pool.query('SELECT operation_type, status, attempt FROM billing_operations ORDER BY created_at, operation_type, attempt')).rows as { operation_type: string; status: string; attempt: number }[];
async function freeSubscriber(u = alice) {
  await subscribe(u, 'free');
  h.clock.advanceMs(10 * DAY);
}

describe('mid-charge: a request parked inside the provider (gate), deterministic', () => {
  it('a duplicate request while the first is mid-charge is rejected as in-progress; releasing completes the first; one charge', async () => {
    await freeSubscriber();
    const gate = h.provider.holdNextCharge();
    const first = started(upgrade(alice, 'pro_monthly'));
    await gate.entered;

    const duplicate = await upgrade(alice, 'pro_monthly');
    expect(duplicate.status).toBe(409);
    expect(errOf(duplicate).code).toBe('OPERATION_IN_PROGRESS');
    expect(await currentPlan(alice)).toBe('free'); // nothing applied while the charge is in flight

    gate.release();
    const done = await first;
    expect(done.status).toBe(200);
    expect(subOf(done).plan.code).toBe('pro_monthly');
    expect(h.provider.processedCharges).toBe(1);
    expect(h.provider.chargeCalls).toBe(1); // the duplicate never reached charge()
    expect(await opRows()).toEqual([{ operation_type: 'charge', status: 'succeeded', attempt: 1 }]);
    expect(await invoicesOf(alice)).toHaveLength(1);
    expect((await eventTypes(alice)).filter((t) => t === 'upgraded')).toHaveLength(1);
    expect(await billingInvariantViolations(pool)).toEqual([]);
  });

  it('five more upgrade requests (same and different target plans) while one is mid-charge: all rejected, one charge in total', async () => {
    await freeSubscriber();
    const gate = h.provider.holdNextCharge();
    const first = started(upgrade(alice, 'pro_monthly'));
    await gate.entered;
    const others = await Promise.all([
      upgrade(alice, 'pro_monthly'),
      upgrade(alice, 'pro_monthly'),
      upgrade(alice, 'business_monthly'),
      upgrade(alice, 'business_monthly'),
      upgrade(alice, 'business_monthly'),
    ]);
    expect(others.map((r) => r.status)).toEqual([409, 409, 409, 409, 409]);
    expect(others.every((r) => errOf(r).code === 'OPERATION_IN_PROGRESS')).toBe(true);
    gate.release();
    expect((await first).status).toBe(200);
    expect(h.provider.processedCharges).toBe(1);
    expect(await opRows()).toHaveLength(1);
    expect(await billingInvariantViolations(pool)).toEqual([]);
  });

  it('simultaneous paid subscribes while the first is mid-charge: exactly one subscription and one charge', async () => {
    const gate = h.provider.holdNextCharge();
    const first = started(subscribe(alice, 'pro_monthly'));
    await gate.entered;
    const others = await Promise.all(Array.from({ length: 4 }, () => subscribe(alice, 'pro_monthly')));
    expect(others.every((r) => r.status === 409 && errOf(r).code === 'OPERATION_IN_PROGRESS')).toBe(true);
    gate.release();
    expect((await first).status).toBe(201);
    expect(h.provider.processedCharges).toBe(1);
    expect(await count(pool, 'SELECT 1 FROM subscriptions')).toBe(1);
    expect(await opRows()).toHaveLength(1);
  });

  it('identical requests with the same Idempotency-Key: the second is REQUEST_IN_PROGRESS until the first finishes, then replays', async () => {
    await freeSubscriber();
    const gate = h.provider.holdNextCharge();
    const first = started(upgrade(alice, 'pro_monthly', { 'Idempotency-Key': 'dup' }));
    await gate.entered;
    const second = await upgrade(alice, 'pro_monthly', { 'Idempotency-Key': 'dup' });
    expect(second.status).toBe(409);
    expect(errOf(second).code).toBe('REQUEST_IN_PROGRESS');
    gate.release();
    const done = await first;
    expect(done.status).toBe(200);
    const replay = await upgrade(alice, 'pro_monthly', { 'Idempotency-Key': 'dup' });
    expect(replay.status).toBe(200);
    expect(replay.headers['idempotent-replay']).toBe('true');
    expect(replay.body).toEqual(done.body);
    expect(h.provider.processedCharges).toBe(1);
  });

  it('a provider slower than the timeout is an unknown outcome; once it completes, a retry resolves it without a second charge', async () => {
    h = createHarness(pool, { timeoutMs: 40 });
    alice = await signup(h, 'slow@example.com');
    await freeSubscriber(alice);
    const gate = h.provider.holdNextCharge(); // never released until we say so: the timeout MUST fire
    const res = await upgrade(alice, 'pro_monthly');
    expect(res.status).toBe(409);
    expect(errOf(res).code).toBe('OPERATION_IN_PROGRESS');
    expect(await opRows()).toEqual([{ operation_type: 'charge', status: 'pending', attempt: 1 }]);

    gate.release();
    await gate.completed; // the provider finishes the charge in the background
    const retry = await upgrade(alice, 'pro_monthly');
    expect(retry.status).toBe(200);
    expect(h.provider.processedCharges).toBe(1);
    expect(h.provider.chargeCalls).toBe(1);
    expect(await opRows()).toHaveLength(1);
  });
});

describe('state changed while the payment was in flight (gate), deterministic', () => {
  it('upgrade: paused mid-charge -> plan unchanged, refund recorded then processed, obligation can be re-attempted', async () => {
    await freeSubscriber();
    const gate = h.provider.holdNextCharge();
    const upgrading = started(upgrade(alice, 'pro_monthly'));
    await gate.entered;
    expect((await api(h, alice).post('/subscriptions/pause')).status).toBe(200);
    gate.release();
    const res = await upgrading;
    expect(res.status).toBe(409);
    expect(errOf(res).code).toBe('STATE_CHANGED');

    const sub = subOf(await api(h, alice).get('/subscriptions/current'));
    expect(sub).toMatchObject({ status: 'paused' });
    expect(sub.plan.code).toBe('free');
    expect(await invoicesOf(alice)).toEqual([]);
    expect(await opRows()).toEqual([
      { operation_type: 'charge', status: 'succeeded', attempt: 1 },
      { operation_type: 'refund', status: 'succeeded', attempt: 1 },
    ]);
    expect(h.provider.processedRefunds).toBe(1);
    expect(await eventTypes(alice)).toContain('charge_discarded');
    expect(await billingInvariantViolations(pool)).toEqual([]);

    await api(h, alice).post('/subscriptions/resume');
    expect((await upgrade(alice, 'pro_monthly')).status).toBe(200);
    expect((await opRows()).filter((o) => o.operation_type === 'charge').map((o) => [o.attempt, o.status])).toEqual([[1, 'succeeded'], [2, 'succeeded']]);
    expect(await billingInvariantViolations(pool)).toEqual([]);
  });

  it('a refund whose provider call is unknown stays pending and is completed by the job', async () => {
    await freeSubscriber();
    const gate = h.provider.holdNextCharge();
    const upgrading = started(upgrade(alice, 'pro_monthly'));
    await gate.entered;
    await api(h, alice).post('/subscriptions/pause');
    const realRefund = h.provider.refund.bind(h.provider);
    h.provider.refund = () => Promise.reject(new ProviderUnavailableError('refund timed out'));
    gate.release();
    expect((await upgrading).status).toBe(409);
    expect((await opRows()).map((o) => [o.operation_type, o.status])).toEqual([['charge', 'succeeded'], ['refund', 'pending']]);
    expect(h.provider.processedRefunds).toBe(0);

    h.provider.refund = realRefund;
    expect((await reconcilePendingOperations(h.deps, { olderThanMs: 0 })).refunds).toEqual({ succeeded: 1, failed: 0, pending: 0 });
    expect(h.provider.processedRefunds).toBe(1);
    expect((await reconcilePendingOperations(h.deps, { olderThanMs: 0 })).refunds).toEqual({ succeeded: 0, failed: 0, pending: 0 });
  });

  it('subscribe: a free subscription created while the paid charge is in flight causes a refund', async () => {
    const gate = h.provider.holdNextCharge();
    const paid = started(subscribe(alice, 'pro_monthly'));
    await gate.entered;
    expect((await subscribe(alice, 'free')).status).toBe(201);
    gate.release();
    const res = await paid;
    expect(res.status).toBe(409);
    expect(errOf(res).code).toBe('STATE_CHANGED');
    expect(await currentPlan(alice)).toBe('free');
    expect(await count(pool, 'SELECT 1 FROM subscriptions')).toBe(1);
    expect(h.provider.processedRefunds).toBe(1);
    expect((await opRows()).map((o) => [o.operation_type, o.status])).toEqual([['charge', 'succeeded'], ['refund', 'succeeded']]);
    expect(await billingInvariantViolations(pool)).toEqual([]);
  });
});

describe('simultaneous starts (no timing assumptions): only order-independent invariants are asserted', () => {
  it('N simultaneous upgrades to the same plan: one charge, one plan change (callers may each see success)', async () => {
    await freeSubscriber();
    const results = await Promise.all(Array.from({ length: 6 }, () => upgrade(alice, 'pro_monthly')));
    // A request that finds the in-flight attempt for the SAME obligation may resolve it and also report success, so
    // several 200s are legitimate. What must hold: at least one succeeded, nothing else went wrong, and ONE charge happened.
    expect(results.some((r) => r.status === 200)).toBe(true);
    expect(results.every((r) => [200, 400, 409].includes(r.status))).toBe(true);
    expect(await invoicesOf(alice)).toHaveLength(1);
    expect(h.provider.processedCharges).toBe(1);
    expect(await opRows()).toHaveLength(1);
    expect((await eventTypes(alice)).filter((t) => t === 'upgraded')).toHaveLength(1);
    expect(await billingInvariantViolations(pool)).toEqual([]);
  });

  it('simultaneous upgrades to different plans: one charge, one winner', async () => {
    await freeSubscriber();
    const results = await Promise.all([upgrade(alice, 'pro_monthly'), upgrade(alice, 'business_monthly')]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(h.provider.processedCharges).toBe(1);
    expect((await eventTypes(alice)).filter((t) => t === 'upgraded')).toHaveLength(1);
    expect(await billingInvariantViolations(pool)).toEqual([]);
  });

  it('simultaneous paid subscribes: one subscription, one charge (callers may each see success)', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => subscribe(alice, 'pro_monthly')));
    expect(results.some((r) => r.status === 201)).toBe(true);
    expect(results.every((r) => [201, 409].includes(r.status))).toBe(true);
    expect(h.provider.processedCharges).toBe(1);
    expect(await count(pool, 'SELECT 1 FROM subscriptions')).toBe(1);
    expect(await opRows()).toHaveLength(1);
  });

  it('simultaneous identical requests with one Idempotency-Key: one execution, everyone gets 200 or an in-progress 409', async () => {
    await freeSubscriber();
    const results = await Promise.all(Array.from({ length: 4 }, () => upgrade(alice, 'pro_monthly', { 'Idempotency-Key': 'same' })));
    expect(results.filter((r) => r.status === 200 && r.headers['idempotent-replay'] === undefined)).toHaveLength(1);
    expect(results.filter((r) => r.status !== 200).every((r) => r.status === 409 && ['REQUEST_IN_PROGRESS', 'INVALID_TRANSITION'].includes(errOf(r).code))).toBe(true);
    expect(h.provider.processedCharges).toBe(1);
  });
});
