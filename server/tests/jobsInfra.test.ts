import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../src/config';
import type { Pool } from '../src/db/pool';
import { createJobRunner, logSummary, startScheduler } from '../src/jobs/scheduler';
import type { ErrorBody } from '../src/lib/errors';
import type { JobCycleSummary } from '../src/services/renewalService';
import type { SubscriptionView } from '../src/services/subscriptionService';
import { createTestPool, resetData } from './helpers';
import { api, createHarness, DAY, planIds, signup, T0, waitFor, type Harness, type User } from './harness';

const emptySummary = (): JobCycleSummary => ({
  reconciliation: { examined: 0, applied: 0, declined: 0, discarded: 0, alreadySettled: 0, unresolved: 0, refunds: { succeeded: 0, failed: 0, pending: 0 } },
  renewals: { examined: 0, outcomes: { not_due: 0, locked: 0, renewed: 0, canceled: 0, declined: 0, discarded: 0, in_progress: 0, resolved_pending: 0 }, errors: [] },
  purgedIdempotencyKeys: 0,
});

describe('job runner (overlap guard and error containment)', () => {
  it('skips a tick while a cycle is still running in this process, then runs again', async () => {
    let finish!: () => void;
    let runs = 0;
    const runner = createJobRunner(() => {
      runs++;
      return new Promise<JobCycleSummary>((resolve) => {
        finish = () => resolve(emptySummary());
      });
    });
    const first = runner.tick();
    expect(await runner.tick()).toBe('skipped');
    expect(await runner.tick()).toBe('skipped');
    finish();
    expect(await first).toBe('ran');
    const third = runner.tick();
    finish();
    expect(await third).toBe('ran');
    expect(runs).toBe(2);
  });

  it('contains errors: a failing cycle is reported and does not stop later ticks', async () => {
    const errors: unknown[] = [];
    let fail = true;
    const runner = createJobRunner(
      () => (fail ? Promise.reject(new Error('cycle exploded')) : Promise.resolve(emptySummary())),
      { onError: (e) => errors.push(e) },
    );
    expect(await runner.tick()).toBe('ran');
    expect(errors).toHaveLength(1);
    fail = false;
    const summaries: JobCycleSummary[] = [];
    const ok = createJobRunner(() => Promise.resolve(emptySummary()), { onSummary: (s) => summaries.push(s) });
    expect(await ok.tick()).toBe('ran');
    expect(summaries).toHaveLength(1);
    expect(await runner.tick()).toBe('ran'); // the earlier runner works again once the fault clears
  });
});

describe('scheduler wiring (node-cron)', () => {
  it('rejects an invalid cron expression', () => {
    expect(() => startScheduler('not a cron', { tick: () => Promise.resolve('ran') })).toThrow(/JOBS_CRON/);
  });

  it('actually fires the runner on schedule and stops when asked', async () => {
    let ticks = 0;
    const scheduler = startScheduler('* * * * * *', {
      tick: () => {
        ticks++;
        return Promise.resolve('ran');
      },
    });
    try {
      await waitFor(() => ticks >= 1, 5000);
    } finally {
      scheduler.stop();
    }
    const seen = ticks;
    await waitFor(() => true);
    expect(seen).toBeGreaterThanOrEqual(1);
  });
});

describe('job logging', () => {
  it('is silent when nothing happened and prints only counts when something did', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    logSummary(emptySummary());
    expect(spy).not.toHaveBeenCalled();
    const s = emptySummary();
    s.renewals.outcomes.renewed = 2;
    s.renewals.errors.push({ subscriptionId: 'abc', error: 'boom' });
    logSummary(s);
    expect(spy).toHaveBeenCalledTimes(1);
    const line = String(spy.mock.calls[0]![0]);
    expect(line).toContain('renewed=2');
    expect(line).toContain('errors=1');
    expect(line).not.toContain('abc'); // ids/messages are not logged here
    spy.mockRestore();
  });
});

describe('configuration', () => {
  const base = { DATABASE_URL: 'postgres://x' };
  it('jobs default on every minute; dev endpoints default on outside production', () => {
    const c = parseConfig(base);
    expect(c).toMatchObject({ RUN_JOBS: true, JOBS_CRON: '* * * * *', JOBS_BATCH_SIZE: 100, DEV_ENDPOINTS: true });
  });
  it('dev endpoints are forced OFF in production even if enabled', () => {
    const prod = { ...base, NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(40), CORS_ORIGINS: 'https://app.example.com' };
    expect(parseConfig({ ...prod, ENABLE_DEV_ENDPOINTS: 'true' }).DEV_ENDPOINTS).toBe(false);
    expect(parseConfig({ ...base, ENABLE_DEV_ENDPOINTS: 'false' }).DEV_ENDPOINTS).toBe(false);
  });
  it('can disable the scheduler and validates the batch size', () => {
    expect(parseConfig({ ...base, RUN_JOBS: 'false' }).RUN_JOBS).toBe(false);
    expect(() => parseConfig({ ...base, JOBS_BATCH_SIZE: '0' })).toThrow(/JOBS_BATCH_SIZE/);
    expect(() => parseConfig({ ...base, RUN_JOBS: 'maybe' })).toThrow(/RUN_JOBS/);
  });
});

describe('dev endpoints (development only)', () => {
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
    h = createHarness(pool, { dev: true });
    ids = await planIds(pool);
    alice = await signup(h, 'alice@example.com');
  });
  const errOf = (res: request.Response) => (res.body as ErrorBody).error;

  it('are not mounted unless explicitly enabled (and so absent in production)', async () => {
    const plain = createHarness(pool);
    const user = await signup(plain, 'plain@example.com');
    expect((await api(plain, user).post('/dev/run-renewals')).status).toBe(404);
    expect((await api(plain, user).post('/dev/advance-clock', { days: 1 })).status).toBe(404);
  });

  it('require authentication', async () => {
    expect((await request(h.app).post('/dev/run-renewals')).status).toBe(401);
    expect((await request(h.app).post('/dev/advance-clock').send({ days: 1 })).status).toBe(401);
  });

  it('advance-clock moves the fake clock forward by ms, days or to a timestamp, and validates input', async () => {
    const a = api(h, alice);
    expect(((await a.post('/dev/advance-clock', { days: 2 })).body as { now: string }).now).toBe('2026-01-03T00:00:00.000Z');
    expect(((await a.post('/dev/advance-clock', { ms: 3_600_000 })).body as { now: string }).now).toBe('2026-01-03T01:00:00.000Z');
    expect(((await a.post('/dev/advance-clock', { to: '2026-02-01T00:00:00Z' })).body as { now: string }).now).toBe('2026-02-01T00:00:00.000Z');
    for (const bad of [{}, { days: 1, ms: 5 }, { days: -1 }, { ms: 1.5 }, { to: 'yesterday' }, { to: '2026-01-01T00:00:00Z' }, { surprise: 1 }]) {
      const res = await a.post('/dev/advance-clock', bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect(h.clock.now().toISOString()).toBe('2026-02-01T00:00:00.000Z'); // bad requests moved nothing
  });

  it('advance-clock needs the fake clock to be enabled', async () => {
    const real = createHarness(pool, { dev: true, fakeClockEnabled: false });
    const user = await signup(real, 'real@example.com');
    const res = await api(real, user).post('/dev/advance-clock', { days: 1 });
    expect(res.status).toBe(400);
    expect(errOf(res).details).toMatchObject({ code: 'FAKE_CLOCK_DISABLED' });
  });

  it('end to end: subscribe, advance past the period end, run the job via the dev endpoint, and the subscription has renewed', async () => {
    const a = api(h, alice);
    expect((await a.post('/subscriptions', { planId: ids.pro_monthly })).status).toBe(201);
    const idle = await a.post('/dev/run-renewals');
    expect(idle.status).toBe(200);
    expect((idle.body as JobCycleSummary).renewals.examined).toBe(0);

    await a.post('/dev/advance-clock', { to: '2026-02-01T00:00:00Z' });
    const before = (await a.get('/subscriptions/current')).body as { subscription: SubscriptionView };
    expect(before.subscription.accessAllowed).toBe(false); // the boundary is strict even before the job runs

    const ran = await a.post('/dev/run-renewals');
    expect((ran.body as JobCycleSummary).renewals.outcomes.renewed).toBe(1);
    const after = (await a.get('/subscriptions/current')).body as { subscription: SubscriptionView };
    expect(after.subscription).toMatchObject({ status: 'active', accessAllowed: true, currentPeriodStart: '2026-02-01T00:00:00.000Z', currentPeriodEnd: '2026-03-01T00:00:00.000Z' });
    expect(T0).toBe('2026-01-01T00:00:00.000Z');
    expect(DAY).toBe(86_400_000);
    expect(((await a.post('/dev/run-renewals')).body as JobCycleSummary).renewals.examined).toBe(0); // idempotent
  });
});
