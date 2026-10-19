import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from '../src/db/pool';
import type { ErrorBody } from '../src/lib/errors';
import type { HistoryEvent, InvoiceView, SubscriptionView, UpgradePreview } from '../src/services/subscriptionService';
import { createTestPool, resetData } from './helpers';
import { api, billingInvariantViolations, count, createHarness, DAY, planIds, signup, T0, type Harness, type User } from './harness';

let pool: Pool;
let h: Harness;
let ids: Record<string, string>;
let alice: User;
let bob: User;

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
  bob = await signup(h, 'bob@example.com');
});

const errOf = (res: request.Response) => (res.body as ErrorBody).error;
const subOf = (res: request.Response) => (res.body as { subscription: SubscriptionView }).subscription;
const subscribe = (u: User, code: string) => api(h, u).post('/subscriptions', { planId: ids[code] });
const eventTypes = async (u: User) => ((await api(h, u).get('/subscriptions/history')).body as { events: HistoryEvent[] }).events.map((e) => e.type);
const row = async (u: User) => (await pool.query('SELECT * FROM subscriptions WHERE user_id = $1 AND status <> \'canceled\'', [u.userId])).rows[0] as Record<string, unknown> | undefined;

/** Puts the user's subscription into past_due as the (future) renewal job would. */
async function forcePastDue(u: User, sinceOffsetMs = -3_600_000, retryCount = 0) {
  const since = new Date(h.clock.now().getTime() + sinceOffsetMs);
  await pool.query(
    `UPDATE subscriptions SET status = 'past_due', past_due_since = $2, next_retry_at = $3, retry_count = $4 WHERE user_id = $1 AND status <> 'canceled'`,
    [u.userId, since, new Date(since.getTime() + (retryCount + 1) * DAY), retryCount],
  );
  return since;
}

describe('GET /plans', () => {
  it('is public and lists the seeded plans by price', async () => {
    const res = await request(h.app).get('/plans');
    expect(res.status).toBe(200);
    const plans = (res.body as { plans: { code: string; priceCents: number; interval: string; limits: Record<string, number> }[] }).plans;
    expect(plans.map((p) => p.code)).toEqual(['free', 'pro_monthly', 'business_monthly', 'pro_yearly']);
    expect(plans[1]).toMatchObject({ priceCents: 49_900, interval: 'month', limits: { api_calls: 5000, projects: 10, seats: 3 } });
  });
});

describe('authentication and authorization', () => {
  it.each([
    ['GET', '/subscriptions/current'],
    ['GET', '/subscriptions/history'],
    ['GET', '/subscriptions/upgrade-preview'],
    ['POST', '/subscriptions'],
    ['POST', '/subscriptions/upgrade'],
    ['POST', '/subscriptions/downgrade'],
    ['POST', '/subscriptions/pause'],
    ['POST', '/subscriptions/resume'],
    ['POST', '/subscriptions/cancel'],
    ['POST', '/subscriptions/reactivate'],
    ['DELETE', '/subscriptions/pending-change'],
    ['GET', '/invoices'],
  ])('%s %s requires authentication (401, standard shape)', async (method, path) => {
    const res = await request(h.app)[method.toLowerCase() as 'get'](path);
    expect(res.status).toBe(401);
    expect(errOf(res).code).toBe('UNAUTHENTICATED');
  });

  it("user B can neither see nor modify user A's subscription, invoices or history", async () => {
    await subscribe(alice, 'pro_monthly');
    const b = api(h, bob);
    expect((await b.get('/subscriptions/current')).status).toBe(404);
    expect(((await b.get('/subscriptions/history')).body as { events: unknown[] }).events).toEqual([]);
    expect(((await b.get('/invoices')).body as { invoices: unknown[] }).invoices).toEqual([]);
    for (const [method, path, body] of [
      ['post', '/subscriptions/pause', undefined],
      ['post', '/subscriptions/cancel', undefined],
      ['post', '/subscriptions/upgrade', { planId: ids.business_monthly }],
      ['post', '/subscriptions/downgrade', { planId: ids.free }],
      ['del', '/subscriptions/pending-change', undefined],
    ] as const) {
      const res = await (b[method] as (p: string, body?: object) => Promise<request.Response>)(path, body);
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(errOf(res).code).toBe('SUBSCRIPTION_NOT_FOUND');
    }
    const a = subOf(await api(h, alice).get('/subscriptions/current'));
    expect(a).toMatchObject({ status: 'active', cancelAtPeriodEnd: false, pausedAt: null });
    expect(h.provider.processedCharges).toBe(1); // only A's own subscribe
  });
});

describe('subscribe', () => {
  it('free plan: active immediately, period of one calendar month from now, no provider call, no invoice', async () => {
    const res = await subscribe(alice, 'free');
    expect(res.status).toBe(201);
    const s = subOf(res);
    expect(s).toMatchObject({
      status: 'active',
      currentPeriodStart: T0,
      currentPeriodEnd: '2026-02-01T00:00:00.000Z',
      cancelAtPeriodEnd: false,
      pendingPlan: null,
      accessAllowed: true,
    });
    expect(s.plan.code).toBe('free');
    expect(h.provider.chargeCalls).toBe(0);
    expect(await count(pool, 'SELECT 1 FROM invoices')).toBe(0);
    expect(await count(pool, 'SELECT 1 FROM billing_operations')).toBe(0);
    expect(await eventTypes(alice)).toEqual(['subscribed']);
  });

  it('paid plan: charges once via the two-phase flow; invoice, operation and event agree', async () => {
    const res = await subscribe(alice, 'pro_monthly');
    expect(res.status).toBe(201);
    expect(subOf(res)).toMatchObject({ status: 'active', currentPeriodEnd: '2026-02-01T00:00:00.000Z' });
    expect(h.provider.processedCharges).toBe(1);

    const ops = (await pool.query('SELECT * FROM billing_operations')).rows as Record<string, unknown>[];
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      user_id: alice.userId,
      operation_type: 'charge',
      status: 'succeeded',
      amount_cents: 49_900,
      attempt: 1,
      obligation_key: `initial:${alice.userId}:1`,
      idempotency_key: `charge:initial:${alice.userId}:1:attempt:1`,
    });
    expect(ops[0]!.subscription_id).toBe(subOf(res).id); // linked after activation
    expect(ops[0]!.provider_reference).toMatch(/^mock_ch_/);

    const invoices = ((await api(h, alice).get('/invoices')).body as { invoices: InvoiceView[] }).invoices;
    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({ kind: 'initial', status: 'paid', amountCents: 49_900, billingPeriodStart: T0 });
    expect(ops[0]!.invoice_id).toBe(invoices[0]!.id);

    const events = ((await api(h, alice).get('/subscriptions/history')).body as { events: HistoryEvent[] }).events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'subscribed', fromStatus: null, toStatus: 'active', createdAt: T0 });
    expect(events[0]!.meta).toMatchObject({ plan_id: ids.pro_monthly, amount_cents: 49_900, period_start: T0, period_end: '2026-02-01T00:00:00.000Z' });
    expect(await billingInvariantViolations(pool)).toEqual([]);
  });

  it('yearly plan gets a one-year period', async () => {
    const s = subOf(await subscribe(alice, 'pro_yearly'));
    expect(s.currentPeriodEnd).toBe('2027-01-01T00:00:00.000Z');
  });

  it('month-end start clamps (Jan 31 -> Feb 28)', async () => {
    h.clock.set('2026-01-31T10:00:00Z');
    expect(subOf(await subscribe(alice, 'free')).currentPeriodEnd).toBe('2026-02-28T10:00:00.000Z');
  });

  it('declined charge: 402, no subscription, failure recorded, retry creates attempt 2 and succeeds', async () => {
    h.provider.declineNext();
    const res = await subscribe(alice, 'pro_monthly');
    expect(res.status).toBe(402);
    expect(errOf(res).code).toBe('PAYMENT_FAILED');
    expect(await row(alice)).toBeUndefined();
    expect(await count(pool, 'SELECT 1 FROM invoices')).toBe(0); // an invoice needs a subscription
    let ops = (await pool.query('SELECT attempt, status, idempotency_key FROM billing_operations ORDER BY attempt')).rows;
    expect(ops).toEqual([{ attempt: 1, status: 'failed', idempotency_key: `charge:initial:${alice.userId}:1:attempt:1` }]);

    const retry = await subscribe(alice, 'pro_monthly');
    expect(retry.status).toBe(201);
    ops = (await pool.query('SELECT attempt, status, idempotency_key FROM billing_operations ORDER BY attempt')).rows;
    expect(ops).toEqual([
      { attempt: 1, status: 'failed', idempotency_key: `charge:initial:${alice.userId}:1:attempt:1` },
      { attempt: 2, status: 'succeeded', idempotency_key: `charge:initial:${alice.userId}:1:attempt:2` },
    ]);
    expect(h.provider.processedCharges).toBe(1);
  });

  it('a second subscribe is rejected with 409 INVALID_TRANSITION (one open subscription per user)', async () => {
    await subscribe(alice, 'free');
    const res = await subscribe(alice, 'pro_monthly');
    expect(res.status).toBe(409);
    expect(errOf(res)).toMatchObject({ code: 'INVALID_TRANSITION', details: { action: 'subscribe', reason: 'already_subscribed', status: 'active' } });
    expect(h.provider.chargeCalls).toBe(0);
  });

  it('after a canceled subscription the user can subscribe again; history of both is kept', async () => {
    await subscribe(alice, 'pro_monthly');
    await pool.query(
      `UPDATE subscriptions SET status = 'canceled', canceled_at = $2, cancel_reason = 'user_requested' WHERE user_id = $1`,
      [alice.userId, h.clock.now()],
    );
    expect((await api(h, alice).get('/subscriptions/current')).status).toBe(404);
    h.clock.advanceMs(40 * DAY);
    const res = await subscribe(alice, 'pro_monthly');
    expect(res.status).toBe(201);
    expect(await count(pool, 'SELECT 1 FROM subscriptions WHERE user_id = $1', [alice.userId])).toBe(2);
    const keys = (await pool.query('SELECT obligation_key FROM billing_operations ORDER BY created_at')).rows.map((r: { obligation_key: string }) => r.obligation_key);
    expect(keys).toEqual([`initial:${alice.userId}:1`, `initial:${alice.userId}:2`]);
    expect(await billingInvariantViolations(pool)).toEqual([]);
  });

  it('validates input and plan existence', async () => {
    expect((await api(h, alice).post('/subscriptions', {})).status).toBe(400);
    expect((await api(h, alice).post('/subscriptions', { planId: 'nope' })).status).toBe(400);
    expect((await api(h, alice).post('/subscriptions', { planId: ids.free, extra: 1 })).status).toBe(400);
    const missing = await api(h, alice).post('/subscriptions', { planId: '11111111-1111-4111-8111-111111111111' });
    expect(missing.status).toBe(404);
    expect(errOf(missing).code).toBe('PLAN_NOT_FOUND');
    const bad = await api(h, alice).post('/subscriptions', { planId: 'nope' });
    expect(errOf(bad).code).toBe('VALIDATION_ERROR');
    expect(await row(alice)).toBeUndefined();
  });
});

describe('GET /subscriptions/current', () => {
  it('404 when there is no subscription; otherwise the full view with server-computed access', async () => {
    const none = await api(h, alice).get('/subscriptions/current');
    expect(none.status).toBe(404);
    expect(errOf(none).code).toBe('SUBSCRIPTION_NOT_FOUND');
    await subscribe(alice, 'business_monthly');
    const s = subOf(await api(h, alice).get('/subscriptions/current'));
    expect(s.plan).toMatchObject({ code: 'business_monthly', priceCents: 149_900, limits: { api_calls: 50_000, projects: 100, seats: 25 } });
    expect(s).toMatchObject({ accessAllowed: true, graceEndsAt: null, pastDueSince: null });
  });
});

describe('upgrade and proration', () => {
  it('free -> pro mid-period charges the prorated amount, switches the plan immediately, keeps the period', async () => {
    await subscribe(alice, 'free');
    h.clock.advanceMs(10 * DAY); // 21 of 31 days remain
    const res = await api(h, alice).post('/subscriptions/upgrade', { planId: ids.pro_monthly });
    expect(res.status).toBe(200);
    const s = subOf(res);
    expect(s.plan.code).toBe('pro_monthly');
    expect(s.currentPeriodStart).toBe(T0);
    expect(s.currentPeriodEnd).toBe('2026-02-01T00:00:00.000Z');

    const expected = Math.round((49_900 * 21) / 31); // 33803
    expect(expected).toBe(33_803);
    expect(h.provider.processedCharges).toBe(1);
    const invoices = ((await api(h, alice).get('/invoices')).body as { invoices: InvoiceView[] }).invoices;
    expect(invoices).toEqual([expect.objectContaining({ kind: 'upgrade_proration', status: 'paid', amountCents: expected, billingPeriodStart: T0 })]);

    const events = ((await api(h, alice).get('/subscriptions/history')).body as { events: HistoryEvent[] }).events;
    const upgraded = events.find((e) => e.type === 'upgraded')!;
    expect(upgraded.createdAt).toBe(h.clock.now().toISOString());
    expect(upgraded.meta).toMatchObject({
      from_plan_id: ids.free,
      to_plan_id: ids.pro_monthly,
      amount_cents: expected,
      remaining_ms: 21 * DAY,
      total_ms: 31 * DAY,
      period_start: T0,
      period_end: '2026-02-01T00:00:00.000Z',
      cleared_pending_plan_id: null,
    });
    const op = (await pool.query('SELECT * FROM billing_operations')).rows[0] as Record<string, unknown>;
    expect(op).toMatchObject({ status: 'succeeded', amount_cents: expected, attempt: 1 });
    expect(op.idempotency_key).toBe(`charge:upgrade:${s.id}:${T0}:${ids.free}:${ids.pro_monthly}:1:attempt:1`);
    expect(await billingInvariantViolations(pool)).toEqual([]);
  });

  it('upgrade-preview returns the same amount the charge uses and never charges or writes', async () => {
    await subscribe(alice, 'free');
    h.clock.advanceMs(10 * DAY);
    const res = await api(h, alice).get(`/subscriptions/upgrade-preview?planId=${ids.pro_monthly}`);
    expect(res.status).toBe(200);
    const preview = (res.body as { preview: UpgradePreview }).preview;
    expect(preview).toMatchObject({ amountCents: 33_803, chargeRequired: true, remainingMs: 21 * DAY, totalMs: 31 * DAY, computedAt: h.clock.now().toISOString() });
    expect(preview.fromPlan.code).toBe('free');
    expect(preview.toPlan.code).toBe('pro_monthly');
    expect(h.provider.chargeCalls).toBe(0);
    expect(await count(pool, 'SELECT 1 FROM billing_operations')).toBe(0);
    expect(await count(pool, 'SELECT 1 FROM subscription_events')).toBe(1); // only 'subscribed'
    const up = await api(h, alice).post('/subscriptions/upgrade', { planId: ids.pro_monthly });
    expect(up.status).toBe(200);
    expect(((await api(h, alice).get('/invoices')).body as { invoices: InvoiceView[] }).invoices[0]!.amountCents).toBe(preview.amountCents);
  });

  it('preview validates its query and applies the same rules as upgrade', async () => {
    await subscribe(alice, 'pro_monthly');
    expect((await api(h, alice).get('/subscriptions/upgrade-preview')).status).toBe(400);
    expect((await api(h, alice).get(`/subscriptions/upgrade-preview?planId=${ids.pro_yearly}`)).status).toBe(400);
    expect((await api(h, alice).get(`/subscriptions/upgrade-preview?planId=${ids.free}`)).status).toBe(400);
    expect((await api(h, bob).get(`/subscriptions/upgrade-preview?planId=${ids.business_monthly}`)).status).toBe(404);
  });

  it('a prorated amount that rounds to 0 switches the plan with NO provider call and NO invoice, but is audited', async () => {
    await subscribe(alice, 'free');
    h.clock.set(new Date(Date.parse('2026-02-01T00:00:00Z') - 1)); // 1 ms left of the period
    const res = await api(h, alice).post('/subscriptions/upgrade', { planId: ids.pro_monthly });
    expect(res.status).toBe(200);
    expect(subOf(res).plan.code).toBe('pro_monthly');
    expect(h.provider.chargeCalls).toBe(0);
    expect(await count(pool, 'SELECT 1 FROM invoices')).toBe(0);
    expect(await count(pool, 'SELECT 1 FROM billing_operations')).toBe(0);
    const upgraded = ((await api(h, alice).get('/subscriptions/history')).body as { events: HistoryEvent[] }).events.find((e) => e.type === 'upgraded')!;
    expect(upgraded.meta).toMatchObject({ amount_cents: 0, remaining_ms: 1, invoice_id: null, operation_id: null });
  });

  it('two upgrades in one period create two distinct obligations and invoices', async () => {
    await subscribe(alice, 'free');
    h.clock.advanceMs(10 * DAY);
    await api(h, alice).post('/subscriptions/upgrade', { planId: ids.pro_monthly });
    await api(h, alice).post('/subscriptions/upgrade', { planId: ids.business_monthly });
    const invoices = ((await api(h, alice).get('/invoices')).body as { invoices: InvoiceView[] }).invoices;
    expect(invoices.map((i) => i.amountCents).sort((a, b) => a - b)).toEqual([33_803, 67_742]); // 100000*21/31 = 67741.9
    expect(await eventTypes(alice)).toEqual(['subscribed', 'upgraded', 'upgraded']);
    expect(subOf(await api(h, alice).get('/subscriptions/current')).plan.code).toBe('business_monthly');
    expect(await billingInvariantViolations(pool)).toEqual([]);
  });

  it('rejects invalid plan changes with 400 and does not charge', async () => {
    await subscribe(alice, 'pro_monthly');
    h.provider.chargeCalls = 0;
    const same = await api(h, alice).post('/subscriptions/upgrade', { planId: ids.pro_monthly });
    expect(same.status).toBe(400);
    expect(errOf(same).details).toMatchObject({ reason: 'same_plan' });
    const interval = await api(h, alice).post('/subscriptions/upgrade', { planId: ids.pro_yearly });
    expect(interval.status).toBe(400);
    expect(errOf(interval).details).toMatchObject({ reason: 'interval_mismatch' });
    const cheaper = await api(h, alice).post('/subscriptions/upgrade', { planId: ids.free });
    expect(cheaper.status).toBe(400);
    expect(errOf(cheaper).details).toMatchObject({ reason: 'not_an_upgrade' });
    expect((await api(h, alice).post('/subscriptions/upgrade', { planId: '11111111-1111-4111-8111-111111111111' })).status).toBe(404);
    expect(h.provider.chargeCalls).toBe(0);
  });

  it('is rejected (409) from paused and past_due, and (404) without a subscription', async () => {
    expect((await api(h, alice).post('/subscriptions/upgrade', { planId: ids.pro_monthly })).status).toBe(404);
    await subscribe(alice, 'free');
    await api(h, alice).post('/subscriptions/pause');
    const paused = await api(h, alice).post('/subscriptions/upgrade', { planId: ids.pro_monthly });
    expect(paused.status).toBe(409);
    expect(errOf(paused)).toMatchObject({ code: 'INVALID_TRANSITION', details: { status: 'paused' } });
    await api(h, alice).post('/subscriptions/resume');
    await forcePastDue(alice);
    const pastDue = await api(h, alice).post('/subscriptions/upgrade', { planId: ids.pro_monthly });
    expect(pastDue.status).toBe(409);
    expect(errOf(pastDue).details).toMatchObject({ status: 'past_due' });
    expect(h.provider.chargeCalls).toBe(0);
  });

  it('declined upgrade: plan unchanged, failed invoice kept, retry succeeds and flips the SAME invoice to paid', async () => {
    await subscribe(alice, 'free');
    h.clock.advanceMs(10 * DAY);
    h.provider.declineNext();
    const failed = await api(h, alice).post('/subscriptions/upgrade', { planId: ids.pro_monthly });
    expect(failed.status).toBe(402);
    expect(errOf(failed).code).toBe('PAYMENT_FAILED');
    expect(subOf(await api(h, alice).get('/subscriptions/current')).plan.code).toBe('free');
    let invoices = ((await api(h, alice).get('/invoices')).body as { invoices: InvoiceView[] }).invoices;
    expect(invoices).toEqual([expect.objectContaining({ status: 'failed', amountCents: 33_803 })]);
    const failedInvoiceId = invoices[0]!.id;
    expect(await eventTypes(alice)).toEqual(['subscribed']); // nothing was applied
    expect(await billingInvariantViolations(pool)).toEqual([]);

    h.clock.advanceMs(DAY); // retry a day later: amount is recomputed (20/31), attempt number increments
    const retry = await api(h, alice).post('/subscriptions/upgrade', { planId: ids.pro_monthly });
    expect(retry.status).toBe(200);
    expect(subOf(retry).plan.code).toBe('pro_monthly');
    invoices = ((await api(h, alice).get('/invoices')).body as { invoices: InvoiceView[] }).invoices;
    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({ id: failedInvoiceId, status: 'paid' });
    const ops = (await pool.query('SELECT attempt, status, amount_cents, idempotency_key FROM billing_operations ORDER BY attempt')).rows as { attempt: number; status: string; idempotency_key: string; amount_cents: number }[];
    expect(ops.map((o) => [o.attempt, o.status])).toEqual([[1, 'failed'], [2, 'succeeded']]);
    expect(ops[0]!.idempotency_key).toMatch(/:attempt:1$/);
    expect(ops[1]!.idempotency_key).toMatch(/:attempt:2$/);
    expect(h.provider.processedCharges).toBe(1);
    expect(await billingInvariantViolations(pool)).toEqual([]);
  });
});

describe('downgrade and pending changes', () => {
  it('schedules a downgrade without changing the current plan or period; replacing and idempotent re-request', async () => {
    await subscribe(alice, 'business_monthly');
    const res = await api(h, alice).post('/subscriptions/downgrade', { planId: ids.pro_monthly });
    expect(res.status).toBe(200);
    const s = subOf(res);
    expect(s.plan.code).toBe('business_monthly'); // limits stay until period end
    expect(s.pendingPlan?.code).toBe('pro_monthly');
    expect(s.currentPeriodEnd).toBe('2026-02-01T00:00:00.000Z');

    expect(subOf(await api(h, alice).post('/subscriptions/downgrade', { planId: ids.free })).pendingPlan?.code).toBe('free'); // replaces
    await api(h, alice).post('/subscriptions/downgrade', { planId: ids.free }); // same again: no duplicate event
    const events = ((await api(h, alice).get('/subscriptions/history')).body as { events: HistoryEvent[] }).events.filter((e) => e.type === 'downgrade_scheduled');
    expect(events).toHaveLength(2);
    expect(events[1]!.meta).toMatchObject({ from_plan_id: ids.business_monthly, to_plan_id: ids.free, replaced_pending_plan_id: ids.pro_monthly, effective_at: '2026-02-01T00:00:00.000Z' });
    expect(h.provider.processedCharges).toBe(1); // only the subscribe charge
  });

  it('rejects interval changes and non-downgrades with 400', async () => {
    await subscribe(alice, 'pro_monthly');
    const interval = await api(h, alice).post('/subscriptions/downgrade', { planId: ids.pro_yearly });
    expect(interval.status).toBe(400);
    expect(errOf(interval).details).toMatchObject({ reason: 'interval_mismatch' });
    const same = await api(h, alice).post('/subscriptions/downgrade', { planId: ids.pro_monthly });
    expect(same.status).toBe(400);
    const higher = await api(h, alice).post('/subscriptions/downgrade', { planId: ids.business_monthly });
    expect(higher.status).toBe(400);
    expect(errOf(higher).details).toMatchObject({ reason: 'not_a_downgrade' });
    expect((await api(h, alice).post('/subscriptions/downgrade', { planId: '11111111-1111-4111-8111-111111111111' })).status).toBe(404);
  });

  it('is allowed while paused, rejected from past_due, and survives pause/resume', async () => {
    await subscribe(alice, 'business_monthly');
    await api(h, alice).post('/subscriptions/downgrade', { planId: ids.pro_monthly });
    await api(h, alice).post('/subscriptions/pause');
    expect(subOf(await api(h, alice).post('/subscriptions/downgrade', { planId: ids.free })).pendingPlan?.code).toBe('free'); // while paused
    const resumed = subOf(await api(h, alice).post('/subscriptions/resume'));
    expect(resumed.pendingPlan?.code).toBe('free'); // survived
    await forcePastDue(alice);
    const res = await api(h, alice).post('/subscriptions/downgrade', { planId: ids.pro_monthly });
    expect(res.status).toBe(409);
  });

  it('DELETE /subscriptions/pending-change removes it; 409 when none; works while paused', async () => {
    await subscribe(alice, 'business_monthly');
    const none = await api(h, alice).del('/subscriptions/pending-change');
    expect(none.status).toBe(409);
    expect(errOf(none).details).toMatchObject({ reason: 'no_pending_change' });
    await api(h, alice).post('/subscriptions/downgrade', { planId: ids.pro_monthly });
    await api(h, alice).post('/subscriptions/pause');
    const res = await api(h, alice).del('/subscriptions/pending-change');
    expect(res.status).toBe(200);
    expect(subOf(res).pendingPlan).toBeNull();
    expect(await eventTypes(alice)).toEqual(['subscribed', 'downgrade_scheduled', 'paused', 'downgrade_cleared']);
  });

  it('an upgrade clears a pending downgrade atomically and records it in the event metadata', async () => {
    await subscribe(alice, 'pro_monthly');
    await api(h, alice).post('/subscriptions/downgrade', { planId: ids.free });
    h.clock.advanceMs(5 * DAY);
    const res = await api(h, alice).post('/subscriptions/upgrade', { planId: ids.business_monthly });
    expect(res.status).toBe(200);
    expect(subOf(res)).toMatchObject({ pendingPlan: null });
    expect(subOf(res).plan.code).toBe('business_monthly');
    const events = ((await api(h, alice).get('/subscriptions/history')).body as { events: HistoryEvent[] }).events;
    expect(events.map((e) => e.type)).toEqual(['subscribed', 'downgrade_scheduled', 'downgrade_cleared', 'upgraded']);
    expect(events[2]!.meta).toMatchObject({ reason: 'upgrade', cleared_pending_plan_id: ids.free });
    expect(events[3]!.meta).toMatchObject({ cleared_pending_plan_id: ids.free });
  });
});

describe('pause and resume', () => {
  it('pause records paused_at; resume extends the period by exactly the paused duration and never charges', async () => {
    await subscribe(alice, 'pro_monthly');
    h.clock.advanceMs(3 * DAY);
    const paused = subOf(await api(h, alice).post('/subscriptions/pause'));
    expect(paused).toMatchObject({ status: 'paused', pausedAt: h.clock.now().toISOString(), accessAllowed: false });
    const chargesBefore = h.provider.chargeCalls;

    h.clock.advanceMs(5 * DAY + 3 * 3_600_000);
    const resumed = subOf(await api(h, alice).post('/subscriptions/resume'));
    expect(resumed).toMatchObject({ status: 'active', pausedAt: null, accessAllowed: true });
    expect(resumed.currentPeriodStart).toBe(T0); // same period => usage keeps its row
    expect(resumed.currentPeriodEnd).toBe(new Date(Date.parse('2026-02-01T00:00:00Z') + 5 * DAY + 3 * 3_600_000).toISOString());
    expect(h.provider.chargeCalls).toBe(chargesBefore);
    const events = ((await api(h, alice).get('/subscriptions/history')).body as { events: HistoryEvent[] }).events;
    expect(events.at(-1)).toMatchObject({ type: 'resumed', fromStatus: 'paused', toStatus: 'active' });
    expect(events.at(-1)!.meta).toMatchObject({ paused_ms: 5 * DAY + 3 * 3_600_000, previous_period_end: '2026-02-01T00:00:00.000Z' });
    expect(events.at(-2)).toMatchObject({ type: 'paused', fromStatus: 'active', toStatus: 'paused' });
  });

  it('invalid pause/resume are 409; a scheduled cancel and a pending downgrade survive a pause', async () => {
    await subscribe(alice, 'business_monthly');
    expect((await api(h, alice).post('/subscriptions/resume')).status).toBe(409);
    await api(h, alice).post('/subscriptions/downgrade', { planId: ids.pro_monthly });
    await api(h, alice).post('/subscriptions/cancel');
    await api(h, alice).post('/subscriptions/pause');
    expect((await api(h, alice).post('/subscriptions/pause')).status).toBe(409);
    const r = await row(alice);
    expect(r).toMatchObject({ status: 'paused', cancel_at_period_end: true, pending_plan_id: ids.pro_monthly });
    h.clock.advanceMs(DAY);
    const resumed = subOf(await api(h, alice).post('/subscriptions/resume'));
    expect(resumed).toMatchObject({ status: 'active', cancelAtPeriodEnd: true });
    expect(resumed.pendingPlan?.code).toBe('pro_monthly');
    expect(resumed.currentPeriodEnd).toBe('2026-02-02T00:00:00.000Z');
  });

  it('cannot pause from past_due', async () => {
    await subscribe(alice, 'free');
    await forcePastDue(alice);
    expect((await api(h, alice).post('/subscriptions/pause')).status).toBe(409);
  });
});

describe('cancel and reactivate (active)', () => {
  it('schedules cancellation without changing status; reactivate undoes it', async () => {
    await subscribe(alice, 'pro_monthly');
    h.clock.advanceMs(DAY);
    const res = await api(h, alice).post('/subscriptions/cancel');
    expect(res.status).toBe(200);
    expect(subOf(res)).toMatchObject({ status: 'active', cancelAtPeriodEnd: true, cancelRequestedAt: h.clock.now().toISOString(), accessAllowed: true, canceledAt: null });
    const events = ((await api(h, alice).get('/subscriptions/history')).body as { events: HistoryEvent[] }).events;
    expect(events.at(-1)).toMatchObject({ type: 'cancel_scheduled', fromStatus: 'active', toStatus: 'active' });
    expect(events.at(-1)!.meta).toMatchObject({ effective_at: '2026-02-01T00:00:00.000Z' });

    expect((await api(h, alice).post('/subscriptions/cancel')).status).toBe(409); // already scheduled
    const back = await api(h, alice).post('/subscriptions/reactivate');
    expect(back.status).toBe(200);
    expect(subOf(back)).toMatchObject({ cancelAtPeriodEnd: false, cancelRequestedAt: null });
    expect(await eventTypes(alice)).toEqual(['subscribed', 'cancel_scheduled', 'reactivated']);
  });

  it('cancel while paused is 409 (resume first); reactivate while paused is 409', async () => {
    await subscribe(alice, 'free');
    await api(h, alice).post('/subscriptions/cancel');
    await api(h, alice).post('/subscriptions/pause');
    const r = await api(h, alice).post('/subscriptions/reactivate');
    expect(r.status).toBe(409);
    expect(errOf(r).details).toMatchObject({ reason: 'reactivate_while_paused' });
    await api(h, alice).post('/subscriptions/resume');
    await api(h, alice).post('/subscriptions/reactivate');

    await api(h, alice).post('/subscriptions/pause');
    const c = await api(h, alice).post('/subscriptions/cancel');
    expect(c.status).toBe(409);
    expect(errOf(c).details).toMatchObject({ reason: 'cancel_while_paused' });
  });

  it('reactivate without a scheduled cancel, or after the period has ended, is 409', async () => {
    await subscribe(alice, 'free');
    expect((await api(h, alice).post('/subscriptions/reactivate')).status).toBe(409);
    await api(h, alice).post('/subscriptions/cancel');
    h.clock.set('2026-02-01T00:00:00Z'); // == period end
    const late = await api(h, alice).post('/subscriptions/reactivate');
    expect(late.status).toBe(409);
    expect(errOf(late).details).toMatchObject({ reason: 'period_already_ended' });
  });

  it('cancel keeps a pending downgrade stored (cancellation wins at finalization, later stage)', async () => {
    await subscribe(alice, 'business_monthly');
    await api(h, alice).post('/subscriptions/downgrade', { planId: ids.pro_monthly });
    const s = subOf(await api(h, alice).post('/subscriptions/cancel'));
    expect(s).toMatchObject({ cancelAtPeriodEnd: true });
    expect(s.pendingPlan?.code).toBe('pro_monthly');
  });

  it('cancel validates its body', async () => {
    await subscribe(alice, 'free');
    expect((await api(h, alice).post('/subscriptions/cancel', { immediate: 'yes' })).status).toBe(400);
    expect((await api(h, alice).post('/subscriptions/cancel', { other: true })).status).toBe(400);
    const imm = await api(h, alice).post('/subscriptions/cancel', { immediate: true }); // active + immediate
    expect(imm.status).toBe(400);
    expect(errOf(imm).details).toMatchObject({ reason: 'immediate_requires_past_due' });
    expect(await row(alice)).toMatchObject({ status: 'active', cancel_at_period_end: false });
  });
});

describe('past_due cancellation preserves the 72-hour grace period', () => {
  it('default cancel stops retries, keeps access, and schedules finalization at grace end', async () => {
    await subscribe(alice, 'pro_monthly');
    const since = await forcePastDue(alice, -3_600_000, 1); // failed 1h ago, one retry already failed
    const res = await api(h, alice).post('/subscriptions/cancel');
    expect(res.status).toBe(200);
    const graceEnd = new Date(since.getTime() + 72 * 3_600_000);
    const s = subOf(res);
    expect(s).toMatchObject({
      status: 'past_due',
      cancelAtPeriodEnd: true,
      cancelRequestedAt: h.clock.now().toISOString(),
      accessAllowed: true, // grace preserved
      graceEndsAt: graceEnd.toISOString(),
      nextRetryAt: graceEnd.toISOString(), // job wakes at grace end; no retries before that
      retryCount: 1,
    });
    const events = ((await api(h, alice).get('/subscriptions/history')).body as { events: HistoryEvent[] }).events;
    expect(events.at(-1)).toMatchObject({ type: 'cancel_scheduled', fromStatus: 'past_due', toStatus: 'past_due' });
    expect(events.at(-1)!.meta).toMatchObject({ grace_ends_at: graceEnd.toISOString() });
    expect((await api(h, alice).post('/subscriptions/cancel')).status).toBe(409); // already scheduled
  });

  it('access ends exactly at grace end (server-computed)', async () => {
    await subscribe(alice, 'free');
    const since = await forcePastDue(alice);
    await api(h, alice).post('/subscriptions/cancel');
    h.clock.set(new Date(since.getTime() + 72 * 3_600_000 - 1));
    expect(subOf(await api(h, alice).get('/subscriptions/current')).accessAllowed).toBe(true);
    h.clock.set(new Date(since.getTime() + 72 * 3_600_000));
    expect(subOf(await api(h, alice).get('/subscriptions/current')).accessAllowed).toBe(false);
  });

  it('immediate cancel (explicit opt-in) ends the subscription now', async () => {
    await subscribe(alice, 'pro_monthly');
    await api(h, alice).post('/subscriptions/downgrade', { planId: ids.free });
    await forcePastDue(alice);
    const res = await api(h, alice).post('/subscriptions/cancel', { immediate: true });
    expect(res.status).toBe(200);
    expect(subOf(res)).toMatchObject({ status: 'canceled', cancelReason: 'user_requested', canceledAt: h.clock.now().toISOString(), accessAllowed: false, pendingPlan: null, nextRetryAt: null, pastDueSince: null, retryCount: 0 });
    const events = ((await api(h, alice).get('/subscriptions/history')).body as { events: HistoryEvent[] }).events;
    expect(events.at(-1)).toMatchObject({ type: 'canceled', fromStatus: 'past_due', toStatus: 'canceled' });
    expect(events.at(-1)!.meta).toMatchObject({ immediate: true, reason: 'user_requested', cleared_pending_plan_id: ids.free });
    expect((await api(h, alice).get('/subscriptions/current')).status).toBe(404); // no open subscription remains
  });

  it('reactivate before finalization clears the cancel and restores the retry schedule', async () => {
    await subscribe(alice, 'pro_monthly');
    const since = await forcePastDue(alice, -3_600_000, 1);
    await api(h, alice).post('/subscriptions/cancel');
    const res = await api(h, alice).post('/subscriptions/reactivate');
    expect(res.status).toBe(200);
    expect(subOf(res)).toMatchObject({ status: 'past_due', cancelAtPeriodEnd: false, cancelRequestedAt: null, nextRetryAt: new Date(since.getTime() + 2 * DAY).toISOString() });
  });

  it('allows removing a pending downgrade in past_due, and rejects other lifecycle actions', async () => {
    await subscribe(alice, 'pro_monthly');
    await api(h, alice).post('/subscriptions/downgrade', { planId: ids.free });
    await forcePastDue(alice);
    expect((await api(h, alice).del('/subscriptions/pending-change')).status).toBe(200);
    for (const [path, body] of [
      ['/subscriptions/pause', undefined],
      ['/subscriptions/resume', undefined],
      ['/subscriptions/upgrade', { planId: ids.business_monthly }],
      ['/subscriptions/downgrade', { planId: ids.free }],
      ['/subscriptions/reactivate', undefined],
    ] as const) {
      expect((await api(h, alice).post(path, body)).status, path).toBe(409);
    }
  });
});

describe('audit events and atomicity', () => {
  it('records the whole lifecycle in order, each with from/to status', async () => {
    await subscribe(alice, 'free');
    await api(h, alice).post('/subscriptions/downgrade', { planId: ids.free }).then(() => undefined);
    await api(h, alice).post('/subscriptions/pause');
    await api(h, alice).post('/subscriptions/resume');
    await api(h, alice).post('/subscriptions/cancel');
    await api(h, alice).post('/subscriptions/reactivate');
    expect(await eventTypes(alice)).toEqual(['subscribed', 'paused', 'resumed', 'cancel_scheduled', 'reactivated']);
  });

  it('a failing audit-event insert rolls the state change back (same transaction)', async () => {
    await subscribe(alice, 'free');
    await pool.query(`
      CREATE OR REPLACE FUNCTION fail_paused_event() RETURNS trigger AS $$ BEGIN
        IF NEW.type = 'paused' THEN RAISE EXCEPTION 'injected audit failure'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_paused_event BEFORE INSERT ON subscription_events FOR EACH ROW EXECUTE FUNCTION fail_paused_event();`);
    try {
      const res = await api(h, alice).post('/subscriptions/pause');
      expect(res.status).toBe(500);
      expect(errOf(res).code).toBe('INTERNAL_ERROR');
      expect(JSON.stringify(res.body)).not.toContain('injected');
      expect(await row(alice)).toMatchObject({ status: 'active', paused_at: null }); // rolled back
    } finally {
      await pool.query('DROP TRIGGER fail_paused_event ON subscription_events; DROP FUNCTION fail_paused_event()');
    }
    expect((await api(h, alice).post('/subscriptions/pause')).status).toBe(200);
  });

  it('history only lists the caller\'s events, across subscriptions', async () => {
    await subscribe(alice, 'free');
    await subscribe(bob, 'free');
    await api(h, bob).post('/subscriptions/pause');
    expect(await eventTypes(alice)).toEqual(['subscribed']);
    expect(await eventTypes(bob)).toEqual(['subscribed', 'paused']);
  });
});

describe('request validation', () => {
  it('rejects bodies on lifecycle endpoints that take none, in the standard error shape', async () => {
    await subscribe(alice, 'free');
    for (const path of ['/subscriptions/pause', '/subscriptions/resume', '/subscriptions/reactivate']) {
      const res = await api(h, alice).post(path, { surprise: 1 });
      expect(res.status, path).toBe(400);
      expect(errOf(res)).toMatchObject({ code: 'VALIDATION_ERROR', message: 'Invalid request' });
    }
    const res = await api(h, alice).del('/subscriptions/pending-change');
    expect(res.status).toBe(409); // no body needed; no pending change
  });
});
