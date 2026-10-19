import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from '../src/db/pool';
import type { OperationView, UsageHistoryPeriod } from '../src/services/historyService';
import { createTestPool, resetData } from './helpers';
import { api, createHarness, DAY, planIds, signup, type Harness, type User } from './harness';

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

const operations = async (u: User) => ((await api(h, u).get('/billing/operations')).body as { operations: OperationView[] }).operations;
const usageHistory = async (u: User) => ((await api(h, u).get('/usage/history')).body as { periods: UsageHistoryPeriod[] }).periods;

describe('GET /usage/history (read-only)', () => {
  it('requires authentication', async () => {
    expect((await request(h.app).get('/usage/history')).status).toBe(401);
    expect((await request(h.app).get('/billing/operations')).status).toBe(401);
  });

  it('lists per-period totals, most recent first, marking the current period', async () => {
    await api(h, alice).post('/subscriptions', { planId: ids.free });
    await api(h, alice).post('/usage', { metric: 'api_calls', quantity: 7 });
    await api(h, alice).post('/usage', { metric: 'projects', quantity: 1 });
    // what the renewal job does: roll the period, then use more
    h.clock.set('2026-02-01T00:00:00Z');
    await h.pool.query(`UPDATE subscriptions SET current_period_start = '2026-02-01T00:00:00Z', current_period_end = '2026-03-01T00:00:00Z' WHERE user_id = $1`, [alice.userId]);
    await api(h, alice).post('/usage', { metric: 'api_calls', quantity: 3 });

    expect(await usageHistory(alice)).toEqual([
      { periodStart: '2026-02-01T00:00:00.000Z', isCurrent: true, metrics: [{ metric: 'api_calls', used: 3 }] },
      { periodStart: '2026-01-01T00:00:00.000Z', isCurrent: false, metrics: [{ metric: 'api_calls', used: 7 }, { metric: 'projects', used: 1 }] },
    ]);
  });

  it('is empty without usage and never shows another user\'s usage', async () => {
    await api(h, alice).post('/subscriptions', { planId: ids.free });
    await api(h, bob).post('/subscriptions', { planId: ids.free });
    await api(h, alice).post('/usage', { metric: 'api_calls', quantity: 5 });
    expect(await usageHistory(bob)).toEqual([]);
    expect((await usageHistory(alice))[0]!.metrics).toEqual([{ metric: 'api_calls', used: 5 }]);
  });

  it('caps the number of periods returned', async () => {
    await api(h, alice).post('/subscriptions', { planId: ids.free });
    const { rows } = await pool.query<{ id: string }>('SELECT id FROM subscriptions WHERE user_id = $1', [alice.userId]);
    for (let i = 1; i <= 15; i++) {
      await pool.query(`INSERT INTO usage_records (subscription_id, metric, period_start, quantity, updated_at) VALUES ($1, 'api_calls', $2, $3, now())`, [rows[0]!.id, new Date(Date.UTC(2025, i % 12, 1) - i * DAY), i]);
    }
    expect((await usageHistory(alice)).length).toBeLessThanOrEqual(12);
  });
});

describe('GET /billing/operations (read-only)', () => {
  it('shows succeeded, failed and pending payment attempts with their kind, and hides provider internals', async () => {
    await api(h, alice).post('/subscriptions', { planId: ids.pro_monthly }); // succeeded initial
    h.clock.advanceMs(10 * DAY);
    h.provider.declineNext();
    await api(h, alice).post('/subscriptions/upgrade', { planId: ids.business_monthly }); // failed upgrade
    h.provider.dropNextRequests();
    await api(h, alice).post('/subscriptions/upgrade', { planId: ids.business_monthly }); // unknown -> pending

    const ops = await operations(alice);
    expect(ops.map((o) => [o.kind, o.type, o.status, o.attempt]).sort()).toEqual(
      [['initial', 'charge', 'succeeded', 1], ['upgrade', 'charge', 'failed', 1], ['upgrade', 'charge', 'pending', 2]].sort(),
    );
    const failed = ops.find((o) => o.status === 'failed')!;
    expect(failed.errorMessage).toMatch(/card_declined/);
    expect(failed.amountCents).toBeGreaterThan(0);
    const raw = JSON.stringify(ops);
    expect(raw).not.toMatch(/idempotency|provider_reference|mock_ch_|obligation/i);
  });

  it('exposes a failed refund (a diagnostic record) and pending refunds, never as succeeded', async () => {
    await api(h, alice).post('/subscriptions', { planId: ids.free });
    h.clock.advanceMs(10 * DAY);
    const gate = h.provider.holdNextCharge();
    const upgrading = api(h, alice).post('/subscriptions/upgrade', { planId: ids.pro_monthly }).then((r) => r);
    await gate.entered;
    await api(h, alice).post('/subscriptions/pause');
    h.provider.refund = () => Promise.resolve({ status: 'failed' as const, errorCode: 'refund_not_allowed', message: 'The provider refuses this refund' });
    gate.release();
    expect((await upgrading).status).toBe(409);

    const refund = (await operations(alice)).find((o) => o.type === 'refund')!;
    expect(refund).toMatchObject({ status: 'failed', kind: 'upgrade', reason: 'state_changed' });
    expect(refund.errorMessage).toMatch(/refund_not_allowed/);
    expect(refund.refundOfOperationId).not.toBeNull();
  });

  it('only lists the caller\'s own operations', async () => {
    await api(h, alice).post('/subscriptions', { planId: ids.pro_monthly });
    expect(await operations(bob)).toEqual([]);
    expect(await operations(alice)).toHaveLength(1);
  });
});
