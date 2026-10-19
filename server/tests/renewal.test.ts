import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from '../src/db/pool';
import type { ErrorBody } from '../src/lib/errors';
import { processSubscription, runJobCycle, runRenewals } from '../src/services/renewalService';
import type { HistoryEvent, SubscriptionView } from '../src/services/subscriptionService';
import { createTestPool, resetData } from './helpers';
import { api, billingInvariantViolations, count, createHarness, DAY, planIds, signup, usageInvariantViolations, type Harness, type User } from './harness';

/** Subscribed at T0 (2026-01-01): the first period is [T0, END1). */
const END1 = '2026-02-01T00:00:00.000Z';
const END2 = '2026-03-01T00:00:00.000Z';
const at = (iso: string, plusMs = 0) => new Date(Date.parse(iso) + plusMs);

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
const subscribe = (u: User, code: string) => api(h, u).post('/subscriptions', { planId: ids[code] });
const record = (u: User, quantity = 1) => api(h, u).post('/usage', { metric: 'api_calls', quantity });
const eventTypes = async (u: User) => ((await api(h, u).get('/subscriptions/history')).body as { events: HistoryEvent[] }).events.map((e) => e.type);
const events = async (u: User) => ((await api(h, u).get('/subscriptions/history')).body as { events: HistoryEvent[] }).events;
const renew = () => runRenewals(h.deps);
const cycle = (reconcileAfterMs = 5 * 60_000) => runJobCycle(h.deps, { reconcileAfterMs });
const subRow = async (u: User) =>
  (await pool.query('SELECT * FROM subscriptions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1', [u.userId])).rows[0] as Record<string, unknown> & {
    id: string;
    status: string;
    plan_id: string;
    pending_plan_id: string | null;
    current_period_start: Date;
    current_period_end: Date;
    cancel_at_period_end: boolean;
    cancel_reason: string | null;
    canceled_at: Date | null;
    past_due_since: Date | null;
    next_retry_at: Date | null;
    retry_count: number;
  };
const invoices = async () => (await pool.query('SELECT id, kind, status, amount_cents, billing_period_start, obligation_key, plan_id, description FROM invoices ORDER BY created_at, billing_period_start')).rows as {
  id: string;
  kind: string;
  status: string;
  amount_cents: number;
  billing_period_start: Date;
  obligation_key: string;
  plan_id: string;
  description: string;
}[];
const ops = async () => (await pool.query(`SELECT operation_type, status, attempt, amount_cents, obligation_key, idempotency_key FROM billing_operations ORDER BY created_at, operation_type, attempt`)).rows as {
  operation_type: string;
  status: string;
  attempt: number;
  amount_cents: number;
  obligation_key: string;
  idempotency_key: string;
}[];
const renewalOps = async () => (await ops()).filter((o) => o.obligation_key.startsWith('renewal:') && o.operation_type === 'charge');
const charges = () => h.provider.processedCharges;

async function proSubscriber(u = alice, code = 'pro_monthly') {
  expect((await subscribe(u, code)).status).toBe(201);
}
function failingProvider() {
  h.provider.setFailMode({ kind: 'always' });
}
async function expectCleanInvariants() {
  expect(await billingInvariantViolations(pool)).toEqual([]);
  expect(await usageInvariantViolations(pool)).toEqual([]);
}

describe('period boundary: access, lifecycle and the job agree on the exact instant', () => {
  beforeEach(async () => {
    await subscribe(alice, 'free');
  });

  it('usage is allowed up to the last millisecond and refused from current_period_end, even before the job runs', async () => {
    h.clock.set(at(END1, -1));
    expect((await record(alice)).status).toBe(201);
    expect(subOf(await api(h, alice).get('/subscriptions/current')).accessAllowed).toBe(true);

    h.clock.set(at(END1)); // exactly the boundary; the job has NOT run
    const blocked = await record(alice);
    expect(blocked.status).toBe(402);
    expect(errOf(blocked)).toMatchObject({ code: 'SUBSCRIPTION_INACTIVE', details: { status: 'active', reason: 'period_ended', periodEnd: END1 } });
    expect((await api(h, alice).post('/demo/generate-report')).status).toBe(402);
    expect(subOf(await api(h, alice).get('/subscriptions/current')).accessAllowed).toBe(false);
    const report = (await api(h, alice).get('/usage')).body as { subscription: { accessAllowed: boolean } };
    expect(report.subscription.accessAllowed).toBe(false);

    h.clock.set(at(END1, 7 * DAY)); // a long outage of the job changes nothing: still no access
    expect((await record(alice)).status).toBe(402);
  });

  it('the job treats exactly current_period_end as due, and one millisecond earlier as not due', async () => {
    h.clock.set(at(END1, -1));
    expect((await renew()).examined).toBe(0);
    h.clock.set(at(END1));
    const s = await renew();
    expect(s.examined).toBe(1);
    expect(s.outcomes.renewed).toBe(1);
  });

  it('after the job runs, access returns on a fresh period with fresh counters; the old counters are kept', async () => {
    await record(alice, 100); // exhaust the free allowance
    expect((await record(alice)).status).toBe(429);
    h.clock.set(at(END1));
    expect((await record(alice)).status).toBe(402);
    await renew();
    expect((await record(alice)).status).toBe(201);
    const usage = (await api(h, alice).get('/usage')).body as { period: { start: string; end: string }; usage: { metric: string; used: number }[] };
    expect(usage.period).toEqual({ start: END1, end: END2 });
    expect(usage.usage.find((m) => m.metric === 'api_calls')!.used).toBe(1);
    expect(await count(pool, 'SELECT 1 FROM usage_records')).toBe(2);
    await expectCleanInvariants();
  });

  it('upgrade, upgrade-preview and pause are refused once the period has ended (renewal_due); cancel and downgrade still work', async () => {
    h.clock.set(at(END1));
    for (const res of [
      await api(h, alice).post('/subscriptions/upgrade', { planId: ids.pro_monthly }),
      await api(h, alice).get(`/subscriptions/upgrade-preview?planId=${ids.pro_monthly}`),
      await api(h, alice).post('/subscriptions/pause'),
    ]) {
      expect(res.status).toBe(409);
      expect(errOf(res)).toMatchObject({ code: 'INVALID_TRANSITION', details: { reason: 'renewal_due' } });
    }
    expect((await api(h, alice).post('/subscriptions/reactivate')).status).toBe(409);
    expect(h.provider.chargeCalls).toBe(0); // free subscribe never charged, and nothing was prorated to 0 for a lapsed period
    expect((await api(h, alice).post('/subscriptions/cancel')).status).toBe(200);
  });
});

describe('renewals', () => {
  it('free plan: rolls the period from the OLD end, writes an event, no provider call, no invoice', async () => {
    await subscribe(alice, 'free');
    h.clock.set(at(END1, 3 * DAY + 5 * 3_600_000)); // the job is 3 days late
    const s = await renew();
    expect(s.outcomes.renewed).toBe(1);
    const row = await subRow(alice);
    expect(row.current_period_start.toISOString()).toBe(END1); // not "now"
    expect(row.current_period_end.toISOString()).toBe(END2);
    expect(row.status).toBe('active');
    expect(h.provider.chargeCalls).toBe(0);
    expect(await count(pool, 'SELECT 1 FROM invoices')).toBe(0);
    const ev = (await events(alice)).at(-1)!;
    expect(ev).toMatchObject({ type: 'renewed', fromStatus: 'active', toStatus: 'active' });
    expect(ev.meta).toMatchObject({ trigger: 'renewal', amount_cents: 0, previous_period_end: END1, period_start: END1, period_end: END2, invoice_id: null, recovered_from_past_due: false });
    expect((await renew()).examined).toBe(0); // no longer due
  });

  it('paid plan: one charge, one paid renewal invoice for the right period, durable operation, audit event', async () => {
    await proSubscriber();
    h.clock.set(at(END1));
    const s = await renew();
    expect(s.outcomes.renewed).toBe(1);
    expect(charges()).toBe(2); // initial + renewal
    const sub = await subRow(alice);
    expect(sub).toMatchObject({ status: 'active', retry_count: 0, past_due_since: null, next_retry_at: null });
    expect(sub.current_period_start.toISOString()).toBe(END1);
    expect(sub.current_period_end.toISOString()).toBe(END2);

    const inv = (await invoices()).filter((i) => i.kind === 'renewal');
    expect(inv).toEqual([expect.objectContaining({ status: 'paid', amount_cents: 49_900, description: 'Pro renewal', obligation_key: `renewal:${sub.id}:${END1}` })]);
    expect(inv[0]!.billing_period_start.toISOString()).toBe(END1);
    const op = (await renewalOps())[0]!;
    expect(op).toMatchObject({ status: 'succeeded', attempt: 1, amount_cents: 49_900, idempotency_key: `charge:renewal:${sub.id}:${END1}:attempt:1` });
    const ev = (await events(alice)).at(-1)!;
    expect(ev.type).toBe('renewed');
    expect(ev.meta).toMatchObject({ trigger: 'renewal', amount_cents: 49_900, invoice_id: inv[0]!.id, period_start: END1, period_end: END2, recovered_from_past_due: false });
    await expectCleanInvariants();
  });

  it('month-end anchors clamp (Jan 31 -> Feb 28 -> Mar 28, documented drift)', async () => {
    h.clock.set('2026-01-31T10:00:00Z');
    await subscribe(alice, 'free');
    expect((await subRow(alice)).current_period_end.toISOString()).toBe('2026-02-28T10:00:00.000Z');
    h.clock.set('2026-02-28T10:00:00Z');
    await renew();
    expect((await subRow(alice)).current_period_end.toISOString()).toBe('2026-03-28T10:00:00.000Z');
  });

  it('a yearly subscription renews for a full year from the old end', async () => {
    await proSubscriber(alice, 'pro_yearly');
    h.clock.set('2027-01-01T00:00:00Z');
    await renew();
    const sub = await subRow(alice);
    expect(sub.current_period_end.toISOString()).toBe('2028-01-01T00:00:00.000Z');
    expect((await invoices()).find((i) => i.kind === 'renewal')!.amount_cents).toBe(499_900);
  });

  it('catches up a long outage one period per run, each period charged and invoiced exactly once', async () => {
    await proSubscriber();
    h.clock.set('2026-04-15T00:00:00Z'); // periods ended: Feb 1, Mar 1, Apr 1
    const runs = [await renew(), await renew(), await renew(), await renew()];
    expect(runs.map((r) => r.outcomes.renewed)).toEqual([1, 1, 1, 0]);
    expect((await subRow(alice)).current_period_end.toISOString()).toBe('2026-05-01T00:00:00.000Z');
    expect((await invoices()).filter((i) => i.kind === 'renewal').map((i) => i.billing_period_start.toISOString())).toEqual(['2026-02-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z']);
    expect(charges()).toBe(4);
    await expectCleanInvariants();
  });

  it('only due subscriptions are renewed; paused ones are never touched, and resume does not trigger a renewal', async () => {
    await proSubscriber();
    const bob = await signup(h, 'bob@example.com');
    await proSubscriber(bob);
    h.clock.set(at('2026-01-05T00:00:00Z'));
    expect((await api(h, alice).post('/subscriptions/pause')).status).toBe(200);
    h.clock.set(at(END1, 10 * DAY));
    const s = await renew();
    expect(s.examined).toBe(1); // only bob
    expect((await subRow(alice)).status).toBe('paused');
    expect((await subRow(alice)).current_period_end.toISOString()).toBe(END1);

    const resumed = subOf(await api(h, alice).post('/subscriptions/resume'));
    expect(resumed.currentPeriodEnd).toBe(new Date(Date.parse(END1) + (Date.parse('2026-02-11T00:00:00Z') - Date.parse('2026-01-05T00:00:00Z'))).toISOString());
    expect((await renew()).examined).toBe(0); // resume extended the period: nothing is due, no renewal charge
    expect(charges()).toBe(3); // 2 initial + bob's renewal
    // the extended period still renews later, from the extended end
    h.clock.set(new Date(resumed.currentPeriodEnd));
    await renew();
    expect((await subRow(alice)).current_period_start.toISOString()).toBe(resumed.currentPeriodEnd);
  });
});

describe('pending downgrades and cancellations at renewal (correct order)', () => {
  it('a pending downgrade is applied at renewal: the NEW plan is charged, pending cleared, both events written', async () => {
    await proSubscriber(alice, 'business_monthly');
    await api(h, alice).post('/subscriptions/downgrade', { planId: ids.pro_monthly });
    h.clock.set(at(END1));
    await renew();
    const sub = await subRow(alice);
    expect(sub.plan_id).toBe(ids.pro_monthly);
    expect(sub.pending_plan_id).toBeNull();
    const renewal = (await invoices()).find((i) => i.kind === 'renewal')!;
    expect(renewal).toMatchObject({ amount_cents: 49_900, plan_id: ids.pro_monthly, status: 'paid' });
    expect(await eventTypes(alice)).toEqual(['subscribed', 'downgrade_scheduled', 'renewed', 'downgrade_applied']);
    expect((await events(alice)).at(-1)!.meta).toMatchObject({ from_plan_id: ids.business_monthly, to_plan_id: ids.pro_monthly });
    expect(subOf(await api(h, alice).get('/subscriptions/current')).plan.limits).toMatchObject({ api_calls: 5000 });
  });

  it('a pending downgrade to the free plan renews without any charge or invoice', async () => {
    await proSubscriber();
    await api(h, alice).post('/subscriptions/downgrade', { planId: ids.free });
    h.clock.set(at(END1));
    await renew();
    expect(charges()).toBe(1); // the initial subscribe only
    expect(h.provider.chargeCalls).toBe(1);
    expect((await subRow(alice)).plan_id).toBe(ids.free);
    expect((await invoices()).filter((i) => i.kind === 'renewal')).toEqual([]);
    expect(await eventTypes(alice)).toEqual(['subscribed', 'downgrade_scheduled', 'renewed', 'downgrade_applied']);
  });

  it('a downgrade scheduled while PAUSED survives the pause and is applied at the first renewal after resume', async () => {
    await proSubscriber(alice, 'business_monthly');
    await api(h, alice).post('/subscriptions/pause');
    await api(h, alice).post('/subscriptions/downgrade', { planId: ids.pro_monthly });
    h.clock.set(at('2026-01-10T00:00:00Z'));
    const resumed = subOf(await api(h, alice).post('/subscriptions/resume'));
    h.clock.set(new Date(resumed.currentPeriodEnd));
    await renew();
    expect((await subRow(alice)).plan_id).toBe(ids.pro_monthly);
  });

  it('cancellation wins: a scheduled cancel is finalized with NO charge, the pending plan is cleared, and nothing renews', async () => {
    await proSubscriber(alice, 'business_monthly');
    await api(h, alice).post('/subscriptions/downgrade', { planId: ids.pro_monthly });
    await api(h, alice).post('/subscriptions/cancel');
    h.clock.set(at(END1, 5 * 60_000));
    const s = await renew();
    expect(s.outcomes.canceled).toBe(1);
    const sub = await subRow(alice);
    expect(sub).toMatchObject({ status: 'canceled', cancel_reason: 'user_requested', pending_plan_id: null, plan_id: ids.business_monthly });
    expect(sub.canceled_at!.toISOString()).toBe(at(END1, 5 * 60_000).toISOString());
    expect(h.provider.chargeCalls).toBe(1); // only the initial subscription
    expect((await invoices()).filter((i) => i.kind === 'renewal')).toEqual([]);
    const ev = (await events(alice)).at(-1)!;
    expect(ev).toMatchObject({ type: 'canceled', fromStatus: 'active', toStatus: 'canceled' });
    expect(ev.meta).toMatchObject({ reason: 'user_requested', effective_at: END1, cleared_pending_plan_id: ids.pro_monthly, finalized_by: 'renewal_job' });
    expect((await renew()).examined).toBe(0);
    expect((await api(h, alice).get('/subscriptions/current')).status).toBe(404);
    expect((await record(alice)).status).toBe(402);
    expect((await subscribe(alice, 'free')).status).toBe(201); // the user may subscribe again
  });

  it('a cancel requested on the very last millisecond is finalized at the boundary; one requested at the boundary too (not renewed)', async () => {
    await proSubscriber();
    h.clock.set(at(END1, -1));
    await api(h, alice).post('/subscriptions/cancel');
    h.clock.set(at(END1));
    expect((await renew()).outcomes.canceled).toBe(1);
    expect(charges()).toBe(1);
  });

  it('cancel requested AT the boundary (after it became due, before the job ran) is still honoured', async () => {
    await proSubscriber();
    h.clock.set(at(END1));
    expect((await api(h, alice).post('/subscriptions/cancel')).status).toBe(200);
    expect((await renew()).outcomes.canceled).toBe(1);
    expect(h.provider.chargeCalls).toBe(1);
  });

  it('reactivate before the boundary cancels the cancellation: the subscription then renews normally', async () => {
    await proSubscriber();
    await api(h, alice).post('/subscriptions/cancel');
    await api(h, alice).post('/subscriptions/reactivate');
    h.clock.set(at(END1));
    expect((await renew()).outcomes.renewed).toBe(1);
    expect((await subRow(alice)).status).toBe('active');
  });
});

describe('failed renewals, retries and the 72-hour grace period', () => {
  it('first failure details: failed invoice, failed operation, renewal_failed event, usage allowed during grace', async () => {
    await proSubscriber();
    failingProvider();
    h.clock.set(at(END1, 3_600_000));
    expect((await renew()).outcomes.declined).toBe(1);
    const since = at(END1, 3_600_000);
    const sub = await subRow(alice);
    expect(sub).toMatchObject({ status: 'past_due', retry_count: 0 });
    expect(sub.past_due_since!.toISOString()).toBe(since.toISOString());
    expect(sub.next_retry_at!.toISOString()).toBe(at(since.toISOString(), DAY).toISOString());
    expect((await invoices()).filter((i) => i.kind === 'renewal')).toEqual([expect.objectContaining({ status: 'failed', amount_cents: 49_900 })]);
    expect((await renewalOps()).map((o) => [o.attempt, o.status])).toEqual([[1, 'failed']]);
    const ev = (await events(alice)).at(-1)!;
    expect(ev).toMatchObject({ type: 'renewal_failed', fromStatus: 'active', toStatus: 'past_due' });
    expect(ev.meta).toMatchObject({ retry_count: 0, grace_ends_at: at(since.toISOString(), 72 * 3_600_000).toISOString(), attempt: 1 });
    // access policy during grace
    h.clock.set(at(since.toISOString(), 3_600_000));
    expect((await record(alice)).status).toBe(201);
    const view = subOf(await api(h, alice).get('/subscriptions/current'));
    expect(view).toMatchObject({ status: 'past_due', accessAllowed: true, graceEndsAt: at(since.toISOString(), 72 * 3_600_000).toISOString() });
    await expectCleanInvariants();
  });

  it('retries run once a day anchored to the first failure; the third retry falls exactly on the grace end and ends the subscription', async () => {
    await proSubscriber();
    failingProvider();
    h.clock.set(at(END1));
    await renew(); // first failure; since = END1
    const since = END1;

    h.clock.set(at(since, DAY - 1));
    expect((await renew()).examined).toBe(0); // 1 ms before the first retry: nothing
    h.clock.set(at(since, DAY));
    expect((await renew()).outcomes.declined).toBe(1);
    let sub = await subRow(alice);
    expect(sub).toMatchObject({ status: 'past_due', retry_count: 1 });
    expect(sub.next_retry_at!.toISOString()).toBe(at(since, 2 * DAY).toISOString()); // anchored, not "last attempt + 1 day"

    h.clock.set(at(since, 2 * DAY + 7 * 3_600_000)); // this retry runs 7h late...
    expect((await renew()).outcomes.declined).toBe(1);
    sub = await subRow(alice);
    expect(sub).toMatchObject({ status: 'past_due', retry_count: 2 });
    expect(sub.next_retry_at!.toISOString()).toBe(at(since, 3 * DAY).toISOString()); // ...and the schedule does not drift

    // The instant grace ends: access is already blocked, although the job has not run yet.
    h.clock.set(at(since, 3 * DAY));
    const blocked = await record(alice);
    expect(blocked.status).toBe(402);
    expect(errOf(blocked).details).toMatchObject({ status: 'past_due', reason: 'grace_expired', graceEndsAt: at(since, 3 * DAY).toISOString() });
    // ...but the retry due at that exact instant is still attempted, and its failure ends the subscription.
    const final = await renew();
    expect(final.outcomes.declined).toBe(1);
    sub = await subRow(alice);
    expect(sub).toMatchObject({ status: 'canceled', cancel_reason: 'payment_failed', pending_plan_id: null, retry_count: 0, next_retry_at: null, past_due_since: null });
    expect(sub.canceled_at!.toISOString()).toBe(at(since, 3 * DAY).toISOString());

    expect((await renewalOps()).map((o) => [o.attempt, o.status])).toEqual([[1, 'failed'], [2, 'failed'], [3, 'failed'], [4, 'failed']]);
    expect((await renewalOps()).map((o) => o.idempotency_key.split(':attempt:')[1])).toEqual(['1', '2', '3', '4']);
    expect((await invoices()).filter((i) => i.kind === 'renewal')).toEqual([expect.objectContaining({ status: 'failed' })]); // kept for audit
    expect(await eventTypes(alice)).toEqual(['subscribed', 'renewal_failed', 'renewal_failed', 'renewal_failed', 'renewal_failed', 'canceled']);
    expect((await events(alice)).at(-1)!.meta).toMatchObject({ reason: 'payment_failed', retry_count: 3 });
    expect(h.provider.chargeCalls).toBe(5);
    expect((await renew()).examined).toBe(0);
    expect((await record(alice)).status).toBe(402);
    await expectCleanInvariants();
  });

  it('a successful retry recovers: active again, period rolled from the old end, the SAME invoice flips to paid, retry fields cleared', async () => {
    await proSubscriber();
    failingProvider();
    h.clock.set(at(END1));
    await renew();
    h.clock.set(at(END1, DAY));
    await renew(); // retry 1 fails
    const failedInvoiceId = (await invoices()).find((i) => i.kind === 'renewal')!.id;

    h.provider.setFailMode({ kind: 'never' });
    h.clock.set(at(END1, 2 * DAY));
    expect((await renew()).outcomes.renewed).toBe(1);
    const sub = await subRow(alice);
    expect(sub).toMatchObject({ status: 'active', retry_count: 0, past_due_since: null, next_retry_at: null });
    expect(sub.current_period_start.toISOString()).toBe(END1);
    expect(sub.current_period_end.toISOString()).toBe(END2);
    const inv = (await invoices()).filter((i) => i.kind === 'renewal');
    expect(inv).toEqual([expect.objectContaining({ id: failedInvoiceId, status: 'paid', amount_cents: 49_900 })]);
    expect((await renewalOps()).map((o) => [o.attempt, o.status])).toEqual([[1, 'failed'], [2, 'failed'], [3, 'succeeded']]);
    const ev = (await events(alice)).at(-1)!;
    expect(ev).toMatchObject({ type: 'renewed', fromStatus: 'past_due', toStatus: 'active' });
    expect(ev.meta).toMatchObject({ trigger: 'retry', recovered_from_past_due: true, period_start: END1, period_end: END2 });
    expect((await record(alice)).status).toBe(201);
    await expectCleanInvariants();
  });

  it('a pending downgrade is applied when a retry succeeds (the pending plan price is what gets charged)', async () => {
    await proSubscriber(alice, 'business_monthly');
    await api(h, alice).post('/subscriptions/downgrade', { planId: ids.pro_monthly });
    failingProvider();
    h.clock.set(at(END1));
    await renew();
    expect((await subRow(alice)).pending_plan_id).toBe(ids.pro_monthly); // kept while past_due
    h.provider.setFailMode({ kind: 'never' });
    h.clock.set(at(END1, DAY));
    await renew();
    const sub = await subRow(alice);
    expect(sub).toMatchObject({ status: 'active', plan_id: ids.pro_monthly, pending_plan_id: null });
    expect((await invoices()).find((i) => i.kind === 'renewal')).toMatchObject({ status: 'paid', amount_cents: 49_900, plan_id: ids.pro_monthly });
    await expectCleanInvariants();
  });

  it('job lag after a failure: the first visit at or after the grace end makes ONE final attempt (recovers on success)', async () => {
    await proSubscriber();
    failingProvider();
    h.clock.set(at(END1));
    await renew();
    h.provider.setFailMode({ kind: 'never' });
    h.clock.set(at(END1, 4 * DAY)); // the job was down for 4 days
    expect((await renew()).outcomes.renewed).toBe(1);
    expect((await subRow(alice)).status).toBe('active');
  });

  it('job lag after a failure: the final attempt fails -> canceled (payment_failed), never cancelled without an attempt', async () => {
    await proSubscriber();
    failingProvider();
    h.clock.set(at(END1));
    await renew();
    const callsBefore = h.provider.chargeCalls;
    h.clock.set(at(END1, 4 * DAY));
    expect((await renew()).outcomes.declined).toBe(1);
    expect(h.provider.chargeCalls).toBe(callsBefore + 1); // exactly one final attempt
    expect(await subRow(alice)).toMatchObject({ status: 'canceled', cancel_reason: 'payment_failed' });
  });

  it('a renewal that is first noticed late starts grace at the job time, not retroactively at the period end', async () => {
    await proSubscriber();
    failingProvider();
    h.clock.set(at(END1, 10 * DAY));
    await renew();
    const sub = await subRow(alice);
    expect(sub.past_due_since!.toISOString()).toBe(at(END1, 10 * DAY).toISOString());
    expect(sub.status).toBe('past_due');
  });
});

describe('user-requested cancellation during past_due keeps the full 72-hour grace', () => {
  async function pastDueAtEnd1() {
    await proSubscriber();
    failingProvider();
    h.clock.set(at(END1));
    await renew();
    return END1;
  }

  it('retries stop, access runs to exactly the grace end, then the job finalizes with user_requested and NO charge', async () => {
    const since = await pastDueAtEnd1();
    h.clock.set(at(since, 3_600_000));
    expect((await api(h, alice).post('/subscriptions/cancel')).status).toBe(200);
    const calls = h.provider.chargeCalls;

    h.clock.set(at(since, DAY)); // the first retry would have been due now
    expect((await renew()).examined).toBe(0);
    h.clock.set(at(since, 2 * DAY));
    expect((await renew()).examined).toBe(0);
    expect(h.provider.chargeCalls).toBe(calls); // no renewal attempts after the cancel request
    expect((await record(alice)).status).toBe(201); // access preserved

    h.clock.set(at(since, 72 * 3_600_000 - 1));
    expect((await record(alice)).status).toBe(201);
    expect((await renew()).examined).toBe(0);

    h.clock.set(at(since, 72 * 3_600_000)); // exactly the grace end
    expect((await record(alice)).status).toBe(402);
    expect((await renew()).outcomes.canceled).toBe(1);
    const sub = await subRow(alice);
    expect(sub).toMatchObject({ status: 'canceled', cancel_reason: 'user_requested', pending_plan_id: null });
    expect(h.provider.chargeCalls).toBe(calls);
    expect((await events(alice)).map((e) => e.type)).toEqual(['subscribed', 'renewal_failed', 'cancel_scheduled', 'canceled']);
    expect((await events(alice)).at(-1)!.meta).toMatchObject({ reason: 'user_requested', finalized_by: 'renewal_job', effective_at: at(since, 72 * 3_600_000).toISOString() });
    expect((await invoices()).filter((i) => i.kind === 'renewal')).toEqual([expect.objectContaining({ status: 'failed' })]);
  });

  it('reactivating before the grace end restores the retry schedule, and the job then retries', async () => {
    const since = await pastDueAtEnd1();
    h.clock.set(at(since, 3_600_000));
    await api(h, alice).post('/subscriptions/cancel');
    await api(h, alice).post('/subscriptions/reactivate');
    h.provider.setFailMode({ kind: 'never' });
    h.clock.set(at(since, DAY));
    expect((await renew()).outcomes.renewed).toBe(1);
    expect((await subRow(alice)).status).toBe('active');
  });

  it('immediate cancellation ends it at once and leaves nothing for the job', async () => {
    await pastDueAtEnd1();
    expect((await api(h, alice).post('/subscriptions/cancel', { immediate: true })).status).toBe(200);
    h.clock.set(at(END1, 5 * DAY));
    expect((await renew()).examined).toBe(0);
    expect(await subRow(alice)).toMatchObject({ status: 'canceled', cancel_reason: 'user_requested' });
  });
});

describe('idempotent and concurrent job runs', () => {
  it('running the job repeatedly at the same instant creates no duplicate charge, invoice, event or period', async () => {
    await proSubscriber();
    h.clock.set(at(END1));
    const first = await renew();
    const second = await renew();
    const third = await cycle();
    expect(first.outcomes.renewed).toBe(1);
    expect(second.examined).toBe(0);
    expect(third.renewals.examined).toBe(0);
    expect(charges()).toBe(2);
    expect((await invoices()).filter((i) => i.kind === 'renewal')).toHaveLength(1);
    expect((await eventTypes(alice)).filter((t) => t === 'renewed')).toHaveLength(1);
    expect((await renewalOps())).toHaveLength(1);
    expect((await subRow(alice)).current_period_end.toISOString()).toBe(END2);
  });

  it('five workers racing over three due subscriptions: each renewed exactly once', async () => {
    const users = [alice, await signup(h, 'b@example.com'), await signup(h, 'c@example.com')];
    for (const u of users) await proSubscriber(u);
    h.clock.set(at(END1));
    const summaries = await Promise.all(Array.from({ length: 5 }, () => renew()));
    expect(summaries.reduce((n, s) => n + s.outcomes.renewed, 0)).toBeGreaterThanOrEqual(3); // a late worker may also report an already-settled attempt
    expect(summaries.flatMap((s) => s.errors)).toEqual([]);
    expect(charges()).toBe(6); // 3 initial + 3 renewals
    expect((await invoices()).filter((i) => i.kind === 'renewal')).toHaveLength(3);
    expect((await renewalOps())).toHaveLength(3);
    for (const u of users) {
      expect((await eventTypes(u)).filter((t) => t === 'renewed')).toHaveLength(1);
      expect((await subRow(u)).current_period_end.toISOString()).toBe(END2);
    }
    await expectCleanInvariants();
  });

  it('a row claimed by someone else is skipped, never waited on (FOR UPDATE SKIP LOCKED)', async () => {
    await proSubscriber();
    h.clock.set(at(END1));
    const sub = await subRow(alice);
    const other = await pool.connect();
    try {
      await other.query('BEGIN');
      await other.query('SELECT id FROM subscriptions WHERE id = $1 FOR UPDATE', [sub.id]);
      expect(await processSubscription(h.deps, sub.id)).toBe('locked');
      const s = await renew();
      expect(s.outcomes.locked).toBe(1);
      expect(s.outcomes.renewed).toBe(0);
    } finally {
      await other.query('ROLLBACK');
      other.release();
    }
    expect((await renew()).outcomes.renewed).toBe(1);
    expect(charges()).toBe(2);
  });

  it('a second worker arriving while the first is mid-charge sees the pending attempt and does not charge (deterministic)', async () => {
    await proSubscriber();
    h.clock.set(at(END1));
    const { id } = await subRow(alice);
    const gate = h.provider.holdNextCharge();
    const first = processSubscription(h.deps, id);
    await gate.entered;
    expect(await processSubscription(h.deps, id)).toBe('in_progress');
    expect((await runRenewals(h.deps)).outcomes.in_progress).toBe(1);
    gate.release();
    expect(await first).toBe('renewed');
    expect(charges()).toBe(2);
    expect(h.provider.chargeCalls).toBe(2);
    expect((await renewalOps())).toHaveLength(1);
    await expectCleanInvariants();
  });

  it('a cancel requested while the renewal charge is in flight: the charge is discarded and refunded, the next run finalizes the cancel without charging', async () => {
    await proSubscriber();
    h.clock.set(at(END1));
    const { id } = await subRow(alice);
    const gate = h.provider.holdNextCharge();
    const worker = processSubscription(h.deps, id);
    await gate.entered;
    expect((await api(h, alice).post('/subscriptions/cancel')).status).toBe(200);
    gate.release();
    expect(await worker).toBe('discarded');
    expect(await subRow(alice)).toMatchObject({ status: 'active', cancel_at_period_end: true });
    expect((await subRow(alice)).current_period_end.toISOString()).toBe(END1); // not extended
    expect(h.provider.processedRefunds).toBe(1);
    expect((await ops()).filter((o) => o.operation_type === 'refund').map((o) => o.status)).toEqual(['succeeded']);
    expect(await eventTypes(alice)).toContain('charge_discarded');
    expect((await invoices()).filter((i) => i.kind === 'renewal')).toEqual([]);

    const callsBefore = h.provider.chargeCalls;
    expect((await renew()).outcomes.canceled).toBe(1);
    expect(h.provider.chargeCalls).toBe(callsBefore);
    expect(await subRow(alice)).toMatchObject({ status: 'canceled', cancel_reason: 'user_requested' });
    await expectCleanInvariants();
  });

  it('the pending plan removed while the renewal charge is in flight: discarded and refunded; the next run charges the right plan as attempt 2', async () => {
    await proSubscriber(alice, 'business_monthly');
    await api(h, alice).post('/subscriptions/downgrade', { planId: ids.pro_monthly });
    h.clock.set(at(END1));
    const { id } = await subRow(alice);
    const gate = h.provider.holdNextCharge();
    const worker = processSubscription(h.deps, id);
    await gate.entered; // charging the pro price (49,900) for the pending plan
    expect((await api(h, alice).del('/subscriptions/pending-change')).status).toBe(200);
    gate.release();
    expect(await worker).toBe('discarded');
    expect((await subRow(alice)).plan_id).toBe(ids.business_monthly);

    expect((await renew()).outcomes.renewed).toBe(1);
    const sub = await subRow(alice);
    expect(sub).toMatchObject({ status: 'active', plan_id: ids.business_monthly });
    expect(sub.current_period_end.toISOString()).toBe(END2);
    expect((await renewalOps()).map((o) => [o.attempt, o.status, o.amount_cents])).toEqual([[1, 'succeeded', 49_900], [2, 'succeeded', 149_900]]);
    expect((await invoices()).filter((i) => i.kind === 'renewal')).toEqual([expect.objectContaining({ status: 'paid', amount_cents: 149_900, plan_id: ids.business_monthly })]);
    expect(h.provider.processedRefunds).toBe(1);
    await expectCleanInvariants();
  });
});

describe('recovery after provider success followed by a database failure', () => {
  async function failInvoiceInserts<T>(fn: () => Promise<T>, when = ''): Promise<T> {
    await pool.query(`
      CREATE OR REPLACE FUNCTION fail_invoice_insert() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'injected database failure'; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_invoice_insert BEFORE INSERT ON invoices FOR EACH ROW ${when} EXECUTE FUNCTION fail_invoice_insert();`);
    try {
      return await fn();
    } finally {
      await pool.query('DROP TRIGGER fail_invoice_insert ON invoices; DROP FUNCTION fail_invoice_insert()');
    }
  }

  it('the charge is taken but Tx 2 fails: the NEXT run resolves the same attempt by lookup; exactly one charge, no new attempt', async () => {
    await proSubscriber();
    h.clock.set(at(END1));
    const failed = await failInvoiceInserts(() => renew());
    expect(failed.errors).toHaveLength(1);
    expect(failed.errors[0]!.error).not.toMatch(/password|token/i);
    expect(charges()).toBe(2); // money was taken
    expect((await subRow(alice)).current_period_end.toISOString()).toBe(END1); // nothing applied
    expect((await renewalOps()).map((o) => o.status)).toEqual(['pending']);

    const next = await renew();
    expect(next.outcomes.renewed).toBe(1);
    expect(charges()).toBe(2);
    expect(h.provider.chargeCalls).toBe(2); // the second run never called charge()
    expect((await renewalOps()).map((o) => [o.attempt, o.status])).toEqual([[1, 'succeeded']]);
    expect((await invoices()).filter((i) => i.kind === 'renewal')).toEqual([expect.objectContaining({ status: 'paid' })]);
    expect((await subRow(alice)).current_period_end.toISOString()).toBe(END2);
    await expectCleanInvariants();
  });

  it('one subscription failing does not block the batch; it recovers on the next run', async () => {
    const bob = await signup(h, 'bob@example.com');
    const carol = await signup(h, 'carol@example.com');
    for (const u of [alice, bob, carol]) await proSubscriber(u);
    h.clock.set(at(END1));
    const bobId = (await subRow(bob)).id;
    const s = await failInvoiceInserts(() => renew(), `WHEN (NEW.subscription_id = '${bobId}')`);
    expect(s.errors.map((e) => e.subscriptionId)).toEqual([bobId]);
    expect(s.outcomes.renewed).toBe(2);
    expect((await subRow(alice)).current_period_end.toISOString()).toBe(END2);
    expect((await subRow(carol)).current_period_end.toISOString()).toBe(END2);
    expect((await subRow(bob)).current_period_end.toISOString()).toBe(END1);

    expect((await renew()).outcomes.renewed).toBe(1);
    expect((await subRow(bob)).current_period_end.toISOString()).toBe(END2);
    expect(charges()).toBe(6);
    await expectCleanInvariants();
  });

  it('response lost after the charge: the job cycle (reconciliation first) applies it; renewals then find nothing to do', async () => {
    await proSubscriber();
    h.clock.set(at(END1));
    h.provider.loseNextResponses();
    expect((await renew()).outcomes.in_progress).toBe(1);
    expect(charges()).toBe(2);

    const c = await cycle(0);
    expect(c.reconciliation.applied).toBe(1);
    expect(c.renewals.examined).toBe(0);
    expect(charges()).toBe(2);
    expect(h.provider.chargeCalls).toBe(2);
    expect((await subRow(alice)).current_period_end.toISOString()).toBe(END2);
    expect((await eventTypes(alice)).filter((t) => t === 'renewed')).toHaveLength(1);
    await expectCleanInvariants();
  });

  it('response lost, no reconciler: a later renewal run resolves it through lookup of the ORIGINAL key', async () => {
    await proSubscriber();
    h.clock.set(at(END1));
    h.provider.loseNextResponses();
    await renew();
    expect((await renew()).outcomes.renewed).toBe(1);
    expect(h.provider.chargeCalls).toBe(2);
    expect((await renewalOps()).map((o) => o.attempt)).toEqual([1]);
  });

  it('request dropped before the provider: no new attempt while unresolved; reconciliation proves it never happened and it is NOT a payment failure', async () => {
    await proSubscriber();
    h.clock.set(at(END1));
    h.provider.dropNextRequests();
    expect((await renew()).outcomes.in_progress).toBe(1);
    expect((await renew()).outcomes.in_progress).toBe(1); // still unresolved: never a second key
    expect((await renewalOps())).toHaveLength(1);
    expect(h.provider.processedCharges).toBe(1);

    const c = await cycle(0); // reconcile (marks attempt 1 failed: not found) THEN renew (attempt 2)
    expect(c.reconciliation.declined).toBe(1);
    expect(c.renewals.outcomes.renewed).toBe(1);
    expect((await renewalOps()).map((o) => [o.attempt, o.status])).toEqual([[1, 'failed'], [2, 'succeeded']]);
    expect(await eventTypes(alice)).not.toContain('renewal_failed'); // never went past_due
    expect((await invoices()).filter((i) => i.kind === 'renewal')).toEqual([expect.objectContaining({ status: 'paid' })]);
    expect((await subRow(alice)).status).toBe('active');
    await expectCleanInvariants();
  });
});

describe('refund processing', () => {
  /** A discarded renewal charge leaves a pending refund (the user canceled while the charge was in flight). */
  async function discardedRenewal() {
    await proSubscriber();
    h.clock.set(at(END1));
    const { id } = await subRow(alice);
    const gate = h.provider.holdNextCharge();
    const worker = processSubscription(h.deps, id);
    await gate.entered;
    await api(h, alice).post('/subscriptions/cancel');
    return { release: async () => { gate.release(); return worker; } };
  }

  it('an unknown refund outcome stays pending and is retried every cycle with the SAME refund key until it succeeds', async () => {
    const keys: string[] = [];
    const realRefund = h.provider.refund.bind(h.provider);
    let failures = 2;
    h.provider.refund = (input) => {
      keys.push(input.idempotencyKey);
      if (failures-- > 0) return Promise.reject(new Error('refund timed out'));
      return realRefund(input);
    };
    const run = await discardedRenewal();
    expect(await run.release()).toBe('discarded'); // the inline attempt failed (unknown)
    expect((await ops()).filter((o) => o.operation_type === 'refund').map((o) => o.status)).toEqual(['pending']);

    expect((await cycle()).reconciliation.refunds).toEqual({ succeeded: 0, failed: 0, pending: 1 }); // 2nd failure
    const meta = (await pool.query('SELECT resolve_attempts, last_checked_at FROM billing_operations WHERE operation_type = $1', ['refund'])).rows[0] as { resolve_attempts: number; last_checked_at: Date };
    expect(meta.resolve_attempts).toBe(2);
    expect(meta.last_checked_at).not.toBeNull();

    expect((await cycle()).reconciliation.refunds).toEqual({ succeeded: 1, failed: 0, pending: 0 });
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1); // the same idempotency key every time
    expect(h.provider.processedRefunds).toBe(1);
    expect((await cycle()).reconciliation.refunds).toEqual({ succeeded: 0, failed: 0, pending: 0 }); // nothing left
    expect(h.provider.refundCalls).toBe(1);
  });

  it('a definitive refund failure is kept as a durable record, reported once, and not retried', async () => {
    h.provider.refund = () => Promise.resolve({ status: 'failed' as const, errorCode: 'refund_not_allowed', message: 'The provider refuses this refund' });
    const run = await discardedRenewal();
    expect(await run.release()).toBe('discarded');
    const refund = (await pool.query(`SELECT status, error_message, amount_cents FROM billing_operations WHERE operation_type = 'refund'`)).rows[0] as { status: string; error_message: string; amount_cents: number };
    expect(refund.status).toBe('failed');
    expect(refund.error_message).toMatch(/refund_not_allowed/);
    expect(refund.amount_cents).toBe(49_900);
    expect(await eventTypes(alice)).toContain('charge_discarded'); // the audit trail of why a refund was needed stays

    const callsBefore = h.provider.refundCalls;
    const c = await cycle();
    expect(c.reconciliation.refunds).toEqual({ succeeded: 0, failed: 0, pending: 0 }); // a failed refund is not retried automatically
    expect(h.provider.refundCalls).toBe(callsBefore);
    expect(await count(pool, `SELECT 1 FROM billing_operations WHERE operation_type = 'refund' AND status = 'failed'`)).toBe(1);
  });

  it('refunding a PAID invoice marks it refunded and keeps invoice, charge and refund consistent', async () => {
    await proSubscriber();
    h.clock.set(at(END1));
    await renew();
    const charge = (await pool.query(`SELECT id, user_id, subscription_id, obligation_key, attempt, amount_cents FROM billing_operations WHERE obligation_key LIKE 'renewal:%'`)).rows[0] as {
      id: string; user_id: string; subscription_id: string; obligation_key: string; attempt: number; amount_cents: number;
    };
    await pool.query(
      `INSERT INTO billing_operations (user_id, subscription_id, obligation_key, attempt, idempotency_key, operation_type, refund_of_operation_id, reason, amount_cents, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'refund', $6, 'manual', $7, 'pending', $8, $8)`,
      [charge.user_id, charge.subscription_id, charge.obligation_key, charge.attempt, `refund:${charge.obligation_key}:attempt:${charge.attempt}`, charge.id, charge.amount_cents, h.clock.now()],
    );
    expect((await cycle()).reconciliation.refunds.succeeded).toBe(1);
    expect((await invoices()).find((i) => i.kind === 'renewal')!.status).toBe('refunded');
    expect(await billingInvariantViolations(pool)).toEqual([]);
  });
});
