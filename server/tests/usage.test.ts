import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from '../src/db/pool';
import type { ErrorBody } from '../src/lib/errors';
import type { MetricUsage, UsageReport } from '../src/services/usageService';
import { enforceLimit } from '../src/middleware/enforceLimit';
import { errorHandler } from '../src/middleware/errorHandler';
import { createTestPool, resetData } from './helpers';
import { api, count, createHarness, DAY, planIds, signup, T0, usageInvariantViolations, waitUntilBlocked, type Harness, type User } from './harness';

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

const started = (t: request.Test): Promise<request.Response> => t.then((r) => r);
const errOf = (res: request.Response) => (res.body as ErrorBody).error;
const subscribe = (u: User, code = 'free') => api(h, u).post('/subscriptions', { planId: ids[code] });
const record = (u: User, metric: unknown, quantity: unknown, headers: Record<string, string> = {}) => api(h, u).post('/usage', { metric, quantity }, headers);
const getUsage = async (u: User) => (await api(h, u).get('/usage')).body as UsageReport;
const usedOf = async (u: User, metric = 'api_calls') => (await getUsage(u)).usage.find((m) => m.metric === metric)!.used;
const demo = (u: User) => api(h, u).post('/demo/generate-report');
const setLimits = (code: string, limits: object) => pool.query('UPDATE plans SET limits = $2::jsonb WHERE code = $1', [code, JSON.stringify(limits)]);
const counter = async () => Number((await pool.query<{ q: string | null }>('SELECT sum(quantity) AS q FROM usage_records')).rows[0]!.q ?? 0);
const ledger = async () => Number((await pool.query<{ q: string | null }>('SELECT sum(quantity) AS q FROM usage_events')).rows[0]!.q ?? 0);
async function forcePastDue(u: User, sinceOffsetMs = -3_600_000) {
  const since = new Date(h.clock.now().getTime() + sinceOffsetMs);
  await pool.query(`UPDATE subscriptions SET status = 'past_due', past_due_since = $2, next_retry_at = $3 WHERE user_id = $1 AND status <> 'canceled'`, [u.userId, since, new Date(since.getTime() + DAY)]);
  return since;
}

describe('authentication and isolation', () => {
  it('requires authentication on GET /usage, POST /usage and the demo endpoint', async () => {
    for (const res of [await request(h.app).get('/usage'), await request(h.app).post('/usage').send({}), await request(h.app).post('/demo/generate-report')]) {
      expect(res.status).toBe(401);
      expect(errOf(res).code).toBe('UNAUTHENTICATED');
    }
  });

  it("each user has their own counters; one user's usage never affects another's", async () => {
    await subscribe(alice);
    await subscribe(bob);
    expect((await record(alice, 'api_calls', 40)).status).toBe(201);
    expect(await usedOf(alice)).toBe(40);
    expect(await usedOf(bob)).toBe(0);
    expect((await record(bob, 'api_calls', 100)).status).toBe(201); // bob's full allowance is unaffected
    expect(await usedOf(alice)).toBe(40);
  });
});

describe('GET /usage', () => {
  it('lists every metric of the current plan with used/limit/remaining, scoped to the stored period', async () => {
    await subscribe(alice);
    await record(alice, 'api_calls', 30);
    const res = await api(h, alice).get('/usage');
    expect(res.status).toBe(200);
    const body = res.body as UsageReport;
    expect(body.period).toEqual({ start: T0, end: '2026-02-01T00:00:00.000Z' });
    expect(body.subscription).toMatchObject({ status: 'active', accessAllowed: true, graceEndsAt: null });
    expect(body.usage).toEqual([
      { metric: 'api_calls', used: 30, limit: 100, remaining: 70, unlimited: false },
      { metric: 'projects', used: 0, limit: 1, remaining: 1, unlimited: false },
      { metric: 'seats', used: 0, limit: 1, remaining: 1, unlimited: false },
    ]);
  });

  it('404 without an open subscription; allowed while paused (read-only) and reports accessAllowed=false', async () => {
    const none = await api(h, alice).get('/usage');
    expect(none.status).toBe(404);
    expect(errOf(none).code).toBe('SUBSCRIPTION_NOT_FOUND');
    await subscribe(alice);
    await record(alice, 'api_calls', 5);
    await api(h, alice).post('/subscriptions/pause');
    const res = await api(h, alice).get('/usage');
    expect(res.status).toBe(200);
    expect((res.body as UsageReport).subscription).toMatchObject({ status: 'paused', accessAllowed: false });
    expect((res.body as UsageReport).usage[0]).toMatchObject({ metric: 'api_calls', used: 5 });
  });
});

describe('POST /usage: validation', () => {
  beforeEach(async () => {
    await subscribe(alice);
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['string', '5'],
    ['null', null],
    ['boolean', true],
    ['too large', 1_000_001],
    ['unsafe integer', 2 ** 53],
  ])('rejects quantity: %s', async (_label, quantity) => {
    const res = await record(alice, 'api_calls', quantity);
    expect(res.status).toBe(400);
    expect(errOf(res).code).toBe('VALIDATION_ERROR');
    expect(await counter()).toBe(0);
    expect(await ledger()).toBe(0);
  });

  it('accepts the quantity bounds 1 and 1,000,000 (the latter then exceeds the limit with 429, not 400)', async () => {
    expect((await record(alice, 'api_calls', 1)).status).toBe(201);
    const big = await record(alice, 'api_calls', 1_000_000);
    expect(big.status).toBe(429);
  });

  it.each([['uppercase', 'API_CALLS'], ['leading digit', '1calls'], ['space', 'api calls'], ['empty', ''], ['too long', `a${'b'.repeat(63)}`], ['dash', 'api-calls']])(
    'rejects metric name: %s',
    async (_l, metric) => {
      const res = await record(alice, metric, 1);
      expect(res.status).toBe(400);
      expect(errOf(res).code).toBe('VALIDATION_ERROR');
    },
  );

  it('rejects missing/extra/mistyped fields', async () => {
    for (const body of [{}, { metric: 'api_calls' }, { quantity: 1 }, { metric: 5, quantity: 1 }, { metric: 'api_calls', quantity: 1, note: 'x' }]) {
      const res = await api(h, alice).post('/usage', body);
      expect(res.status).toBe(400);
    }
    expect(await counter()).toBe(0);
  });

  it('a metric that is not part of the plan is 400 UNKNOWN_METRIC (missing never means unlimited)', async () => {
    const res = await record(alice, 'storage_gb', 1);
    expect(res.status).toBe(400);
    expect(errOf(res).details).toMatchObject({ code: 'UNKNOWN_METRIC', metric: 'storage_gb', allowed: ['api_calls', 'projects', 'seats'] });
    expect(await counter()).toBe(0);
  });
});

describe('limits: boundaries', () => {
  beforeEach(async () => {
    await setLimits('free', { api_calls: 10, projects: 1, seats: 1 });
    await subscribe(alice);
  });

  it('allows usage up to exactly the limit, then rejects with 429 and the full picture', async () => {
    const first = await record(alice, 'api_calls', 9);
    expect(first.status).toBe(201);
    expect((first.body as { usage: MetricUsage }).usage).toEqual({ metric: 'api_calls', used: 9, limit: 10, remaining: 1, unlimited: false });
    const exact = await record(alice, 'api_calls', 1); // used 10 == limit: allowed
    expect(exact.status).toBe(201);
    expect((exact.body as { usage: MetricUsage }).usage).toMatchObject({ used: 10, remaining: 0 });
    const over = await record(alice, 'api_calls', 1);
    expect(over.status).toBe(429);
    expect(errOf(over)).toMatchObject({
      code: 'LIMIT_EXCEEDED',
      details: { metric: 'api_calls', limit: 10, used: 10, remaining: 0, requested: 1, periodEnd: '2026-02-01T00:00:00.000Z' },
    });
    expect(await usedOf(alice)).toBe(10);
  });

  it('is all-or-nothing: a request larger than the remaining allowance consumes nothing', async () => {
    await record(alice, 'api_calls', 6);
    const over = await record(alice, 'api_calls', 5); // only 4 left
    expect(over.status).toBe(429);
    expect(errOf(over).details).toMatchObject({ used: 6, remaining: 4, requested: 5 });
    expect(await usedOf(alice)).toBe(6);
    expect((await record(alice, 'api_calls', 4)).status).toBe(201); // exactly the remainder still fits
    expect(await usedOf(alice)).toBe(10);
  });

  it('a first request bigger than the whole limit is rejected without creating a counter row', async () => {
    const res = await record(alice, 'api_calls', 11);
    expect(res.status).toBe(429);
    expect(errOf(res).details).toMatchObject({ limit: 10, used: 0, remaining: 10, requested: 11 });
    expect(await count(pool, 'SELECT 1 FROM usage_records')).toBe(0);
    expect(await count(pool, 'SELECT 1 FROM usage_events')).toBe(0);
  });

  it('metrics are independent', async () => {
    expect((await record(alice, 'projects', 1)).status).toBe(201);
    expect((await record(alice, 'projects', 1)).status).toBe(429);
    expect((await record(alice, 'api_calls', 10)).status).toBe(201);
    expect(await usedOf(alice, 'seats')).toBe(0);
  });

  it('a rejected request leaves counters and ledger untouched', async () => {
    await record(alice, 'api_calls', 10);
    for (let i = 0; i < 5; i++) expect((await record(alice, 'api_calls', 1)).status).toBe(429);
    expect(await counter()).toBe(10);
    expect(await ledger()).toBe(10);
    expect(await usageInvariantViolations(pool)).toEqual([]);
  });
});

describe('limits: unlimited, zero and malformed values', () => {
  it('JSON null means unlimited: never 429, still counted, reported as unlimited', async () => {
    await setLimits('free', { api_calls: null, projects: 1, seats: 1 });
    await subscribe(alice);
    for (let i = 0; i < 3; i++) expect((await record(alice, 'api_calls', 1_000_000)).status).toBe(201);
    const m = (await getUsage(alice)).usage.find((x) => x.metric === 'api_calls')!;
    expect(m).toEqual({ metric: 'api_calls', used: 3_000_000, limit: null, remaining: null, unlimited: true });
    expect((await demo(alice)).status).toBe(201);
    expect(await usageInvariantViolations(pool)).toEqual([]);
  });

  it('limit 0 means not allowed: always 429 with limit 0 / remaining 0', async () => {
    await setLimits('free', { api_calls: 0, projects: 1, seats: 1 });
    await subscribe(alice);
    const res = await record(alice, 'api_calls', 1);
    expect(res.status).toBe(429);
    expect(errOf(res).details).toMatchObject({ limit: 0, used: 0, remaining: 0 });
    expect((await demo(alice)).status).toBe(429);
    expect(await counter()).toBe(0);
  });

  it.each([['string', 'lots'], ['negative', -5], ['fraction', 1.5], ['boolean', true], ['object', {}], ['array', [1]]])('a malformed limit (%s) denies instead of granting unlimited use', async (_l, bad) => {
    await setLimits('free', { api_calls: bad, projects: 1, seats: 1 });
    await subscribe(alice);
    const res = await record(alice, 'api_calls', 1);
    expect(res.status).toBe(429);
    expect(errOf(res).details).toMatchObject({ limit: 0 });
    expect((await getUsage(alice)).usage[0]).toMatchObject({ metric: 'api_calls', limit: 0, unlimited: false });
  });
});

describe('access policy by subscription status', () => {
  it('no subscription, or a canceled one: 402 SUBSCRIPTION_REQUIRED', async () => {
    const none = await record(alice, 'api_calls', 1);
    expect(none.status).toBe(402);
    expect(errOf(none).code).toBe('SUBSCRIPTION_REQUIRED');
    await subscribe(alice);
    await pool.query(`UPDATE subscriptions SET status = 'canceled', canceled_at = $1, cancel_reason = 'user_requested' WHERE user_id = $2`, [h.clock.now(), alice.userId]);
    const canceled = await record(alice, 'api_calls', 1);
    expect(canceled.status).toBe(402);
    expect(errOf(canceled).code).toBe('SUBSCRIPTION_REQUIRED');
    expect((await demo(alice)).status).toBe(402);
    expect(await counter()).toBe(0);
  });

  it('paused: 402 SUBSCRIPTION_INACTIVE on record and demo; usage frozen; resume keeps the same period and counters', async () => {
    await subscribe(alice);
    await record(alice, 'api_calls', 7);
    await api(h, alice).post('/subscriptions/pause');
    const rec = await record(alice, 'api_calls', 1);
    expect(rec.status).toBe(402);
    expect(errOf(rec)).toMatchObject({ code: 'SUBSCRIPTION_INACTIVE', details: { status: 'paused' } });
    expect((await demo(alice)).status).toBe(402);
    expect(await counter()).toBe(7);

    h.clock.advanceMs(3 * DAY);
    await api(h, alice).post('/subscriptions/resume');
    const after = await getUsage(alice);
    expect(after.period.start).toBe(T0); // same period => same counters
    expect(after.usage[0]).toMatchObject({ metric: 'api_calls', used: 7 });
    expect((await record(alice, 'api_calls', 3)).status).toBe(201);
    expect(await usedOf(alice)).toBe(10);
  });

  it('active with a scheduled cancellation still has access', async () => {
    await subscribe(alice);
    await api(h, alice).post('/subscriptions/cancel');
    expect((await record(alice, 'api_calls', 1)).status).toBe(201);
  });

  it('past_due: allowed strictly before 72h, blocked from exactly 72h with the grace end reported', async () => {
    await subscribe(alice);
    const since = await forcePastDue(alice);
    expect((await record(alice, 'api_calls', 1)).status).toBe(201);
    h.clock.set(new Date(since.getTime() + 72 * 3_600_000 - 1));
    expect((await record(alice, 'api_calls', 1)).status).toBe(201);
    expect((await demo(alice)).status).toBe(201);
    h.clock.set(new Date(since.getTime() + 72 * 3_600_000));
    const blocked = await record(alice, 'api_calls', 1);
    expect(blocked.status).toBe(402);
    expect(errOf(blocked)).toMatchObject({ code: 'SUBSCRIPTION_INACTIVE', details: { status: 'past_due', graceEndsAt: new Date(since.getTime() + 72 * 3_600_000).toISOString() } });
    expect((await demo(alice)).status).toBe(402);
    expect(await counter()).toBe(3);
  });

  it('a pause that commits while a usage request is waiting for the subscription lock wins: the usage is rejected (deterministic)', async () => {
    await subscribe(alice);
    const lifecycle = await pool.connect();
    try {
      await lifecycle.query('BEGIN');
      await lifecycle.query(`SELECT id FROM subscriptions WHERE user_id = $1 FOR UPDATE`, [alice.userId]); // a lifecycle change is in progress
      const usage = started(record(alice, 'api_calls', 1));
      await waitUntilBlocked(pool, 'FOR SHARE OF s'); // the usage request is parked behind it
      await lifecycle.query(`UPDATE subscriptions SET status = 'paused', paused_at = $2 WHERE user_id = $1`, [alice.userId, h.clock.now()]);
      await lifecycle.query('COMMIT');
      const res = await usage;
      expect(res.status).toBe(402);
      expect(errOf(res).details).toMatchObject({ status: 'paused' });
    } finally {
      lifecycle.release();
    }
    expect(await counter()).toBe(0);
  });

  it('conversely, a pause waits for an in-flight usage transaction and then freezes the exact count', async () => {
    await subscribe(alice);
    const inflight = await pool.connect();
    try {
      await inflight.query('BEGIN');
      await inflight.query(`SELECT id FROM subscriptions WHERE user_id = $1 FOR SHARE`, [alice.userId]); // a usage tx holds the share lock
      const pausing = started(api(h, alice).post('/subscriptions/pause'));
      await waitUntilBlocked(pool, 'FOR UPDATE'); // pause is parked behind the usage transaction
      await inflight.query(
        `INSERT INTO usage_events (subscription_id, metric, period_start, quantity, source, created_at)
         SELECT id, 'api_calls', current_period_start, 4, 'api', now() FROM subscriptions WHERE user_id = $1`,
        [alice.userId],
      );
      await inflight.query(
        `INSERT INTO usage_records (subscription_id, metric, period_start, quantity, updated_at)
         SELECT id, 'api_calls', current_period_start, 4, now() FROM subscriptions WHERE user_id = $1`,
        [alice.userId],
      );
      await inflight.query('COMMIT');
      expect((await pausing).status).toBe(200);
    } finally {
      inflight.release();
    }
    expect(await usedOf(alice)).toBe(4);
    expect((await record(alice, 'api_calls', 1)).status).toBe(402);
  });
});

describe('period scoping', () => {
  it('usage is keyed by the stored period start: a new period starts fresh, old rows are kept', async () => {
    await subscribe(alice);
    await record(alice, 'api_calls', 100);
    expect((await record(alice, 'api_calls', 1)).status).toBe(429);

    // What the renewal job will do: roll the stored period forward.
    await pool.query(`UPDATE subscriptions SET current_period_start = '2026-02-01T00:00:00Z', current_period_end = '2026-03-01T00:00:00Z' WHERE user_id = $1`, [alice.userId]);
    h.clock.set('2026-02-02T00:00:00Z');
    const fresh = await getUsage(alice);
    expect(fresh.period).toEqual({ start: '2026-02-01T00:00:00.000Z', end: '2026-03-01T00:00:00.000Z' });
    expect(fresh.usage[0]).toMatchObject({ metric: 'api_calls', used: 0, remaining: 100 });
    expect((await record(alice, 'api_calls', 60)).status).toBe(201);
    const rows = (await pool.query('SELECT period_start, quantity FROM usage_records ORDER BY period_start')).rows as { period_start: Date; quantity: string }[];
    expect(rows.map((r) => [r.period_start.toISOString(), Number(r.quantity)])).toEqual([[T0, 100], ['2026-02-01T00:00:00.000Z', 60]]);
    expect(await usageInvariantViolations(pool)).toEqual([]);
  });

  it('uses the real stored period even for a yearly plan', async () => {
    await subscribe(alice, 'pro_yearly');
    const u = await getUsage(alice);
    expect(u.period).toEqual({ start: T0, end: '2027-01-01T00:00:00.000Z' });
    expect(u.usage.find((m) => m.metric === 'api_calls')).toMatchObject({ limit: 60_000 });
  });

  it('an upgrade keeps the counters and applies the new plan limits immediately; a pending downgrade changes nothing yet', async () => {
    await subscribe(alice);
    await record(alice, 'api_calls', 100);
    expect((await record(alice, 'api_calls', 1)).status).toBe(429);
    h.clock.advanceMs(DAY);
    expect((await api(h, alice).post('/subscriptions/upgrade', { planId: ids.pro_monthly })).status).toBe(200);
    expect(await usedOf(alice)).toBe(100); // same period row
    expect((await record(alice, 'api_calls', 1)).status).toBe(201);
    expect((await getUsage(alice)).usage[0]).toMatchObject({ used: 101, limit: 5000 });
    await api(h, alice).post('/subscriptions/downgrade', { planId: ids.free });
    expect((await getUsage(alice)).usage[0]).toMatchObject({ limit: 5000 }); // still the current plan's limit
  });
});

describe('concurrent usage never exceeds the limit', () => {
  it('150 simultaneous single-unit requests against a limit of 100: exactly 100 succeed', async () => {
    await subscribe(alice);
    const results = await Promise.all(Array.from({ length: 150 }, () => record(alice, 'api_calls', 1)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(100);
    const rejected = results.filter((r) => r.status === 429);
    expect(rejected).toHaveLength(50);
    expect(rejected.every((r) => errOf(r).code === 'LIMIT_EXCEEDED')).toBe(true);
    expect(await usedOf(alice)).toBe(100);
    expect(await ledger()).toBe(100);
    expect(await usageInvariantViolations(pool)).toEqual([]);
  });

  it('100 concurrent increments below the limit sum exactly', async () => {
    await setLimits('free', { api_calls: 1000, projects: 1, seats: 1 });
    await subscribe(alice);
    const results = await Promise.all(Array.from({ length: 100 }, (_, i) => record(alice, 'api_calls', (i % 5) + 1)));
    expect(results.every((r) => r.status === 201)).toBe(true);
    const expected = Array.from({ length: 100 }, (_, i) => (i % 5) + 1).reduce((a, b) => a + b, 0); // 300
    expect(await usedOf(alice)).toBe(expected);
    expect(await ledger()).toBe(expected);
    expect(await count(pool, 'SELECT 1 FROM usage_records')).toBe(1); // one atomic counter row
  });

  it('mixed quantities racing for a small limit: the counter never exceeds it and equals the accepted total', async () => {
    await setLimits('free', { api_calls: 50, projects: 1, seats: 1 });
    await subscribe(alice);
    const quantities = Array.from({ length: 60 }, (_, i) => (i % 7) + 1);
    const results = await Promise.all(quantities.map((q) => record(alice, 'api_calls', q)));
    const accepted = quantities.filter((_, i) => results[i]!.status === 201).reduce((a, b) => a + b, 0);
    expect(results.every((r) => r.status === 201 || r.status === 429)).toBe(true);
    expect(accepted).toBeLessThanOrEqual(50);
    expect(await usedOf(alice)).toBe(accepted);
    expect(await ledger()).toBe(accepted);
    expect(await usageInvariantViolations(pool)).toEqual([]);
  });

  it('concurrent usage by two users is independent', async () => {
    await subscribe(alice);
    await subscribe(bob);
    const results = await Promise.all([
      ...Array.from({ length: 60 }, () => record(alice, 'api_calls', 2)),
      ...Array.from({ length: 60 }, () => record(bob, 'api_calls', 2)),
    ]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(100); // 50 each
    expect(await usedOf(alice)).toBe(100);
    expect(await usedOf(bob)).toBe(100);
  });

  it('concurrent requests with the SAME Idempotency-Key record exactly once', async () => {
    await subscribe(alice);
    const results = await Promise.all(Array.from({ length: 10 }, () => record(alice, 'api_calls', 5, { 'Idempotency-Key': 'evt-1' })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 200 && r.headers['idempotent-replay'] === 'true')).toHaveLength(9);
    expect(await usedOf(alice)).toBe(5);
    expect(await ledger()).toBe(5);
  });
});

describe('POST /usage exactly-once recording (Idempotency-Key)', () => {
  beforeEach(async () => {
    await subscribe(alice);
  });

  it('a repeat returns the original outcome as a replay and consumes nothing more', async () => {
    const first = await record(alice, 'api_calls', 5, { 'Idempotency-Key': 'req-42' });
    const again = await record(alice, 'api_calls', 5, { 'Idempotency-Key': 'req-42' });
    expect([first.status, again.status]).toEqual([201, 200]);
    expect(first.body).toMatchObject({ replayed: false });
    expect(again.body).toMatchObject({ replayed: true });
    expect(again.headers['idempotent-replay']).toBe('true');
    expect(await usedOf(alice)).toBe(5);
  });

  it('the same key for a different metric or quantity is 422', async () => {
    await record(alice, 'api_calls', 5, { 'Idempotency-Key': 'k' });
    const q = await record(alice, 'api_calls', 6, { 'Idempotency-Key': 'k' });
    expect(q.status).toBe(422);
    expect(errOf(q).code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect((await record(alice, 'projects', 5, { 'Idempotency-Key': 'k' })).status).toBe(422);
    expect(await usedOf(alice)).toBe(5);
  });

  it('keys are scoped to the subscription/user', async () => {
    await subscribe(bob);
    expect((await record(alice, 'api_calls', 1, { 'Idempotency-Key': 'shared' })).status).toBe(201);
    expect((await record(bob, 'api_calls', 1, { 'Idempotency-Key': 'shared' })).status).toBe(201);
    expect(await ledger()).toBe(2);
  });

  it('a rejected (429) keyed request is NOT recorded, so the key can be used later', async () => {
    await setLimits('free', { api_calls: 3, projects: 1, seats: 1 });
    expect((await record(alice, 'api_calls', 5, { 'Idempotency-Key': 'big' })).status).toBe(429);
    expect(await count(pool, 'SELECT 1 FROM usage_events')).toBe(0);
    await setLimits('free', { api_calls: 10, projects: 1, seats: 1 });
    expect((await record(alice, 'api_calls', 5, { 'Idempotency-Key': 'big' })).status).toBe(201);
    expect(await usedOf(alice)).toBe(5);
  });

  it('rejects malformed keys', async () => {
    for (const bad of ['has space', 'x'.repeat(256)]) expect((await record(alice, 'api_calls', 1, { 'Idempotency-Key': bad })).status).toBe(400);
  });
});

describe('the demo endpoint: real server-side enforcement, committed atomically with usage', () => {
  beforeEach(async () => {
    await setLimits('free', { api_calls: 3, projects: 1, seats: 1 });
    await subscribe(alice);
  });

  it('succeeds until the limit, then 429; every success has a report AND a usage event, failures have neither', async () => {
    for (let i = 1; i <= 3; i++) {
      const res = await demo(alice);
      expect(res.status).toBe(201);
      expect((res.body as { report: { title: string }; usage: MetricUsage }).report.title).toBe(`Demo report #${i}`);
      expect((res.body as { usage: MetricUsage }).usage).toMatchObject({ metric: 'api_calls', used: i, limit: 3, remaining: 3 - i });
    }
    const over = await demo(alice);
    expect(over.status).toBe(429);
    expect(errOf(over)).toMatchObject({ code: 'LIMIT_EXCEEDED', details: { limit: 3, used: 3, remaining: 0, requested: 1 } });
    expect(await count(pool, 'SELECT 1 FROM demo_reports')).toBe(3);
    expect(await count(pool, `SELECT 1 FROM usage_events WHERE source = 'demo'`)).toBe(3);
    expect(await usedOf(alice)).toBe(3);
    expect(await usageInvariantViolations(pool)).toEqual([]);
    // each report is tied to exactly one usage event
    expect(await count(pool, 'SELECT usage_event_id FROM demo_reports GROUP BY usage_event_id')).toBe(3);
  });

  it('shares the same counter as POST /usage', async () => {
    await record(alice, 'api_calls', 2);
    expect((await demo(alice)).status).toBe(201);
    expect((await demo(alice)).status).toBe(429);
  });

  it('40 simultaneous demo calls against a limit of 20 produce exactly 20 reports and 20 units of usage', async () => {
    await setLimits('free', { api_calls: 20, projects: 1, seats: 1 });
    const results = await Promise.all(Array.from({ length: 40 }, () => demo(alice)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(20);
    expect(results.filter((r) => r.status === 429)).toHaveLength(20);
    expect(await count(pool, 'SELECT 1 FROM demo_reports')).toBe(20);
    expect(await usedOf(alice)).toBe(20);
    expect(await ledger()).toBe(20);
    expect(await usageInvariantViolations(pool)).toEqual([]);
  });

  it('an ineligible subscription is rejected before any work happens', async () => {
    await api(h, alice).post('/subscriptions/pause');
    expect((await demo(alice)).status).toBe(402);
    expect(await count(pool, 'SELECT 1 FROM demo_reports')).toBe(0);
    expect(await counter()).toBe(0);
  });
});

describe('failure recovery: failed requests never consume usage', () => {
  async function withTrigger<T>(sql: string, drop: string, fn: () => Promise<T>): Promise<T> {
    await pool.query(sql);
    try {
      return await fn();
    } finally {
      await pool.query(drop);
    }
  }
  const failOn = (table: string, deferred: boolean) => `
    CREATE OR REPLACE FUNCTION inject_failure() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$ LANGUAGE plpgsql;
    ${deferred ? `CREATE CONSTRAINT TRIGGER inject_failure AFTER INSERT ON ${table} DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION inject_failure();` : `CREATE TRIGGER inject_failure BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION inject_failure();`}`;
  const drop = (table: string) => `DROP TRIGGER inject_failure ON ${table}; DROP FUNCTION inject_failure();`;

  beforeEach(async () => {
    await subscribe(alice);
  });

  it('the metered work fails AFTER usage was consumed in the transaction: 500, and the usage is rolled back', async () => {
    await withTrigger(failOn('demo_reports', false), drop('demo_reports'), async () => {
      const res = await demo(alice);
      expect(res.status).toBe(500);
      expect(errOf(res).code).toBe('INTERNAL_ERROR');
      expect(JSON.stringify(res.body)).not.toContain('injected');
    });
    expect(await counter()).toBe(0);
    expect(await ledger()).toBe(0);
    expect(await count(pool, 'SELECT 1 FROM demo_reports')).toBe(0);
    expect((await demo(alice)).status).toBe(201); // recovers; the failed attempt cost nothing
    expect(await usedOf(alice)).toBe(1);
  });

  it('the work succeeds but the COMMIT fails: the client gets 500 (never a success body) and nothing is consumed or stored', async () => {
    await withTrigger(failOn('demo_reports', true), drop('demo_reports'), async () => {
      const res = await demo(alice);
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred', details: {} } });
    });
    expect(await counter()).toBe(0);
    expect(await ledger()).toBe(0);
    expect(await count(pool, 'SELECT 1 FROM demo_reports')).toBe(0);
    expect(await usageInvariantViolations(pool)).toEqual([]);
  });

  it('POST /usage: a failure after the counter update rolls the counter back (ledger and counter move together)', async () => {
    await withTrigger(failOn('usage_events', false), drop('usage_events'), async () => {
      const res = await record(alice, 'api_calls', 5);
      expect(res.status).toBe(500);
    });
    expect(await counter()).toBe(0);
    expect(await ledger()).toBe(0);
  });

  it('POST /usage with a key: a commit failure leaves nothing behind, and retrying the same key records exactly once', async () => {
    await withTrigger(failOn('usage_events', true), drop('usage_events'), async () => {
      expect((await record(alice, 'api_calls', 5, { 'Idempotency-Key': 'work-7' })).status).toBe(500);
    });
    expect(await counter()).toBe(0);
    const retry = await record(alice, 'api_calls', 5, { 'Idempotency-Key': 'work-7' });
    expect(retry.status).toBe(201);
    const again = await record(alice, 'api_calls', 5, { 'Idempotency-Key': 'work-7' });
    expect(again.status).toBe(200);
    expect(await usedOf(alice)).toBe(5);
    expect(await usageInvariantViolations(pool)).toEqual([]);
  });

  it('failing requests never leak database connections (more failures than the pool size, then a normal request works)', async () => {
    await withTrigger(failOn('demo_reports', true), drop('demo_reports'), async () => {
      for (let i = 0; i < 12; i++) expect((await demo(alice)).status).toBe(500);
    });
    for (let i = 0; i < 12; i++) expect((await record(alice, 'api_calls', 100_000)).status).toBe(429);
    expect(pool.waitingCount).toBe(0);
    expect((await demo(alice)).status).toBe(201);
    expect(await counter()).toBe(1);
  });
});

describe('rate limiting is separate from plan limits', () => {
  it('a per-user request limiter returns 429 RATE_LIMITED, not LIMIT_EXCEEDED', async () => {
    h = createHarness(pool, { usageMax: 3 });
    alice = await signup(h, 'limited@example.com');
    await subscribe(alice);
    for (let i = 0; i < 3; i++) expect((await getUsageStatus(alice))).toBe(200);
    const res = await api(h, alice).get('/usage');
    expect(res.status).toBe(429);
    expect(errOf(res).code).toBe('RATE_LIMITED');
    // another user is unaffected (key is the user, not the IP)
    bob = await signup(h, 'other@example.com');
    await subscribe(bob);
    expect((await api(h, bob).get('/usage')).status).toBe(200);
  });
  const getUsageStatus = async (u: User) => (await api(h, u).get('/usage')).status;
});

describe('enforceLimit finalization rules (any handler, not just the demo)', () => {
  function miniApp() {
    const app = express();
    app.use((req, _res, next) => {
      req.user = { id: String(req.header('x-user')), email: 'x', name: 'x', createdAt: '' };
      next();
    });
    const meter = enforceLimit({ pool, clock: h.clock }, 'api_calls', 2);
    app.post('/ok', meter, (req, res) => {
      res.status(200).json({ used: req.meter!.usage.usage.used });
    });
    app.post('/client-error', meter, (_req, res) => {
      res.status(400).json({ error: { code: 'BAD', message: 'nope', details: {} } });
    });
    app.post('/throws', meter, () => {
      throw new Error('boom: not a database error');
    });
    app.post('/async-throws', meter, async () => {
      await Promise.resolve();
      throw new Error('boom async');
    });
    app.use(errorHandler);
    return app;
  }
  const call = (path: string) => request(miniApp()).post(path).set('x-user', alice.userId);

  beforeEach(async () => {
    await subscribe(alice);
  });

  it('status < 400 commits the usage', async () => {
    const res = await call('/ok');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ used: 2 });
    expect(await usedOf(alice)).toBe(2);
    expect(await ledger()).toBe(2);
  });

  it('a 4xx response rolls the usage back (a failed request consumes nothing)', async () => {
    const res = await call('/client-error');
    expect(res.status).toBe(400);
    expect(await counter()).toBe(0);
    expect(await ledger()).toBe(0);
  });

  it('a handler that throws (sync or async) rolls the usage back and yields a generic 500', async () => {
    for (const path of ['/throws', '/async-throws']) {
      const res = await call(path);
      expect(res.status).toBe(500);
      expect(JSON.stringify(res.body)).not.toContain('boom');
    }
    expect(await counter()).toBe(0);
    expect(await ledger()).toBe(0);
  });

  it('commits happen before the response is sent: a client that sees success can always read the usage', async () => {
    for (let i = 0; i < 10; i++) {
      expect((await call('/ok')).status).toBe(200);
      expect(await usedOf(alice)).toBe((i + 1) * 2);
    }
  });

  it('the connection pool is intact after many rolled-back requests', async () => {
    for (let i = 0; i < 12; i++) await call('/client-error');
    expect(pool.waitingCount).toBe(0);
    expect((await call('/ok')).status).toBe(200);
  });
});
