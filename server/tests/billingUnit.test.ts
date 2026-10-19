import { describe, expect, it } from 'vitest';
import { MockProvider, parseMockFailMode } from '../src/billing/mockProvider';
import { ProviderUnavailableError } from '../src/billing/provider';
import { StripeProvider } from '../src/billing/stripeProvider';
import { GRACE_PERIOD_MS, graceEndsAt, hasAccess } from '../src/lib/access';
import { addInterval } from '../src/lib/periods';
import { computeProration } from '../src/lib/proration';
import { decide, type Action, type SubscriptionSnapshot } from '../src/services/stateMachine';
import type { SubscriptionStatus } from '../src/lib/access';

const d = (s: string) => new Date(s);
const base = { oldPriceCents: 0, newPriceCents: 49_900 };

describe('computeProration', () => {
  const start = d('2026-01-01T00:00:00Z');
  const end = d('2026-02-01T00:00:00Z'); // 31 days

  it('charges the full difference at period start, nothing at period end or after', () => {
    expect(computeProration({ ...base, periodStart: start, periodEnd: end, now: start }).amountCents).toBe(49_900);
    expect(computeProration({ ...base, periodStart: start, periodEnd: end, now: end }).amountCents).toBe(0);
    expect(computeProration({ ...base, periodStart: start, periodEnd: end, now: d('2026-03-01T00:00:00Z') }).amountCents).toBe(0);
  });

  it('clamps a clock before the period start to the full period', () => {
    const r = computeProration({ ...base, periodStart: start, periodEnd: end, now: d('2025-12-01T00:00:00Z') });
    expect(r).toMatchObject({ amountCents: 49_900, remainingMs: r.totalMs });
  });

  it('prorates by actual milliseconds: exactly half way', () => {
    const r = computeProration({ oldPriceCents: 49_900, newPriceCents: 149_900, periodStart: d('2026-04-01T00:00:00Z'), periodEnd: d('2026-05-01T00:00:00Z'), now: d('2026-04-16T00:00:00Z') });
    expect(r.amountCents).toBe(50_000); // 100000 * 15/30
    expect(r.totalMs).toBe(30 * 86_400_000);
  });

  it('uses the real period length, not a hard-coded month: 31-day, 30-day and leap/non-leap February', () => {
    const calc = (s: string, e: string, n: string) => computeProration({ oldPriceCents: 0, newPriceCents: 100_000, periodStart: d(s), periodEnd: d(e), now: d(n) }).amountCents;
    expect(calc('2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z', '2026-01-16T00:00:00Z')).toBe(Math.round((100_000 * 16) / 31)); // 51613
    expect(calc('2026-04-01T00:00:00Z', '2026-05-01T00:00:00Z', '2026-04-11T00:00:00Z')).toBe(66_667); // 20/30 -> 66666.67
    expect(calc('2028-02-01T00:00:00Z', '2028-03-01T00:00:00Z', '2028-02-15T00:00:00Z')).toBe(51_724); // leap: 15/29 -> 51724.14
    expect(calc('2027-02-01T00:00:00Z', '2027-03-01T00:00:00Z', '2027-02-15T00:00:00Z')).toBe(50_000); // 14/28
  });

  it('prorates a yearly period (leap year has 366 days)', () => {
    const r = computeProration({
      oldPriceCents: 0,
      newPriceCents: 499_900,
      periodStart: d('2028-01-01T00:00:00Z'),
      periodEnd: d('2029-01-01T00:00:00Z'),
      now: d('2028-07-01T00:00:00Z'),
    });
    expect(r.totalMs).toBe(366 * 86_400_000);
    expect(r.amountCents).toBe(Math.round((499_900 * 184) / 366)); // Jul 1 -> Jan 1 = 184 days
  });

  it('rounds half up, exactly once, on the final quotient', () => {
    const s = d('2026-01-01T00:00:00.000Z');
    const at = (diff: number, totalMs: number, remainingMs: number) =>
      computeProration({ oldPriceCents: 0, newPriceCents: diff, periodStart: s, periodEnd: new Date(s.getTime() + totalMs), now: new Date(s.getTime() + totalMs - remainingMs) }).amountCents;
    expect(at(1, 2, 1)).toBe(1); // 0.5 -> 1 (half up)
    expect(at(3, 2, 1)).toBe(2); // 1.5 -> 2
    expect(at(5, 2, 1)).toBe(3); // 2.5 -> 3
    expect(at(1, 3, 1)).toBe(0); // 0.333 -> 0
    expect(at(1, 3, 2)).toBe(1); // 0.667 -> 1
    expect(at(10, 4, 1)).toBe(3); // 2.5 -> 3
    expect(at(9, 4, 1)).toBe(2); // 2.25 -> 2
    expect(at(11, 4, 1)).toBe(3); // 2.75 -> 3
  });

  it('is 0 when 1 ms remains of a long period, and one ms in still charges nearly everything', () => {
    const s = d('2026-01-01T00:00:00Z');
    const e = d('2026-02-01T00:00:00Z');
    expect(computeProration({ ...base, periodStart: s, periodEnd: e, now: new Date(e.getTime() - 1) }).amountCents).toBe(0);
    expect(computeProration({ ...base, periodStart: s, periodEnd: e, now: new Date(s.getTime() + 1) }).amountCents).toBe(49_900);
  });

  it('is zero for equal or lower target price (never negative)', () => {
    const s = d('2026-01-01T00:00:00Z');
    const e = d('2026-02-01T00:00:00Z');
    expect(computeProration({ oldPriceCents: 100, newPriceCents: 100, periodStart: s, periodEnd: e, now: s }).amountCents).toBe(0);
    expect(computeProration({ oldPriceCents: 500, newPriceCents: 100, periodStart: s, periodEnd: e, now: s }).amountCents).toBe(0);
  });

  it('is monotonically non-increasing as time passes and never exceeds the price difference', () => {
    const s = d('2026-03-01T00:00:00Z');
    const e = d('2026-04-01T00:00:00Z');
    let previous = Infinity;
    for (let i = 0; i <= 200; i++) {
      const now = new Date(s.getTime() + ((e.getTime() - s.getTime()) * i) / 200);
      const a = computeProration({ oldPriceCents: 49_900, newPriceCents: 149_900, periodStart: s, periodEnd: e, now }).amountCents;
      expect(a).toBeLessThanOrEqual(100_000);
      expect(a).toBeLessThanOrEqual(previous);
      previous = a;
    }
  });

  it('handles large values without overflow (BigInt)', () => {
    const s = d('2000-01-01T00:00:00Z');
    const e = d('2100-01-01T00:00:00Z');
    const r = computeProration({ oldPriceCents: 0, newPriceCents: 2_000_000_000, periodStart: s, periodEnd: e, now: new Date((s.getTime() + e.getTime()) / 2) });
    expect(r.amountCents).toBe(1_000_000_000);
  });

  it('rejects an invalid period', () => {
    const t = d('2026-01-01T00:00:00Z');
    expect(() => computeProration({ ...base, periodStart: t, periodEnd: t, now: t })).toThrow(RangeError);
  });
});

describe('addInterval (UTC, day clamping)', () => {
  const iso = (date: Date) => date.toISOString();
  it('adds a calendar month and clamps to the last day of shorter months', () => {
    expect(iso(addInterval(d('2026-01-31T00:00:00Z'), 'month'))).toBe('2026-02-28T00:00:00.000Z');
    expect(iso(addInterval(d('2028-01-31T00:00:00Z'), 'month'))).toBe('2028-02-29T00:00:00.000Z');
    expect(iso(addInterval(d('2026-03-31T00:00:00Z'), 'month'))).toBe('2026-04-30T00:00:00.000Z');
    expect(iso(addInterval(d('2026-12-31T00:00:00Z'), 'month'))).toBe('2027-01-31T00:00:00.000Z');
    expect(iso(addInterval(d('2026-11-30T00:00:00Z'), 'month'))).toBe('2026-12-30T00:00:00.000Z');
  });
  it('adds a year and clamps Feb 29', () => {
    expect(iso(addInterval(d('2028-02-29T00:00:00Z'), 'year'))).toBe('2029-02-28T00:00:00.000Z');
    expect(iso(addInterval(d('2026-06-15T00:00:00Z'), 'year'))).toBe('2027-06-15T00:00:00.000Z');
  });
  it('preserves the UTC time of day, milliseconds included', () => {
    expect(iso(addInterval(d('2026-01-31T23:59:59.123Z'), 'month'))).toBe('2026-02-28T23:59:59.123Z');
  });
});

describe('hasAccess (period boundary and grace period)', () => {
  const since = d('2026-01-10T12:00:00Z');
  const end = d('2026-02-01T00:00:00Z');
  const snap = (status: SubscriptionStatus, pastDueSince: Date | null = null) => ({ status, pastDueSince, currentPeriodEnd: end });

  it('active: yes strictly before the stored period end, NO at exactly the end and after (stale periods get no access)', () => {
    expect(hasAccess(snap('active'), d('2026-01-15T00:00:00Z'))).toBe(true);
    expect(hasAccess(snap('active'), new Date(end.getTime() - 1))).toBe(true);
    expect(hasAccess(snap('active'), end)).toBe(false);
    expect(hasAccess(snap('active'), new Date(end.getTime() + 1))).toBe(false);
    expect(hasAccess(snap('active'), d('2026-06-01T00:00:00Z'))).toBe(false);
  });
  it('paused/canceled: never', () => {
    expect(hasAccess(snap('paused'), since)).toBe(false);
    expect(hasAccess(snap('canceled'), since)).toBe(false);
  });
  it('past_due: allowed strictly before 72h, blocked at exactly 72h and after, regardless of the (ended) period', () => {
    const sub = { status: 'past_due' as const, pastDueSince: since, currentPeriodEnd: d('2026-01-01T00:00:00Z') };
    expect(GRACE_PERIOD_MS).toBe(72 * 3_600_000);
    expect(graceEndsAt(since).toISOString()).toBe('2026-01-13T12:00:00.000Z');
    expect(hasAccess(sub, since)).toBe(true);
    expect(hasAccess(sub, new Date(since.getTime() + GRACE_PERIOD_MS - 1))).toBe(true);
    expect(hasAccess(sub, new Date(since.getTime() + GRACE_PERIOD_MS))).toBe(false);
    expect(hasAccess(sub, new Date(since.getTime() + GRACE_PERIOD_MS + 1))).toBe(false);
  });
  it('past_due without a timestamp has no access (defensive)', () => {
    expect(hasAccess(snap('past_due'), since)).toBe(false);
  });
});

describe('state machine: every action x status x flags', () => {
  const NOW = d('2026-01-15T00:00:00Z');
  const END_FUTURE = d('2026-02-01T00:00:00Z');
  const END_PAST = d('2026-01-10T00:00:00Z');
  const actions: Action[] = ['subscribe', 'upgrade', 'downgrade', 'removePendingChange', 'pause', 'resume', 'cancel', 'cancelImmediate', 'reactivate'];
  const statuses: SubscriptionStatus[] = ['active', 'paused', 'past_due', 'canceled'];

  // Independent statement of the transition table in docs/STATE_MACHINE.md.
  function expectedOk(a: Action, s: SubscriptionSnapshot): boolean {
    switch (a) {
      case 'subscribe':
        return false; // only valid with NO subscription
      case 'upgrade':
        return s.status === 'active' && s.currentPeriodEnd.getTime() > NOW.getTime(); // not once the period has ended
      case 'downgrade':
        return s.status === 'active' || s.status === 'paused';
      case 'removePendingChange':
        return ['active', 'paused', 'past_due'].includes(s.status) && s.hasPendingPlan;
      case 'pause':
        return s.status === 'active' && s.currentPeriodEnd.getTime() > NOW.getTime();
      case 'resume':
        return s.status === 'paused';
      case 'cancel':
        return (s.status === 'active' || s.status === 'past_due') && !s.cancelAtPeriodEnd;
      case 'cancelImmediate':
        return s.status === 'past_due';
      case 'reactivate':
        if (!s.cancelAtPeriodEnd) return false;
        if (s.status === 'active') return s.currentPeriodEnd.getTime() > NOW.getTime();
        return s.status === 'past_due';
    }
  }
  const expectedTarget = (a: Action, s: SubscriptionStatus): SubscriptionStatus => (a === 'pause' ? 'paused' : a === 'resume' ? 'active' : a === 'cancelImmediate' ? 'canceled' : s);

  it('allows exactly the documented transitions (288 combinations) and reports the right target status', () => {
    let checked = 0;
    for (const action of actions) {
      for (const status of statuses) {
        for (const cancelAtPeriodEnd of [false, true]) {
          for (const hasPendingPlan of [false, true]) {
            for (const ended of [false, true]) {
              const snap: SubscriptionSnapshot = { status, cancelAtPeriodEnd, hasPendingPlan, currentPeriodEnd: ended ? END_PAST : END_FUTURE };
              const got = decide(action, snap, NOW);
              const label = `${action} from ${JSON.stringify({ status, cancelAtPeriodEnd, hasPendingPlan, ended })}`;
              expect(got.ok, label).toBe(expectedOk(action, snap));
              if (got.ok) expect(got.to, label).toBe(expectedTarget(action, status));
              checked++;
            }
          }
        }
      }
    }
    expect(checked).toBe(9 * 4 * 2 * 2 * 2);
  });

  it('subscribe is allowed only when there is no open subscription', () => {
    expect(decide('subscribe', null, NOW)).toEqual({ ok: true, to: 'active' });
    for (const status of ['active', 'paused', 'past_due'] as const) {
      const r = decide('subscribe', { status, cancelAtPeriodEnd: false, hasPendingPlan: false, currentPeriodEnd: END_FUTURE }, NOW);
      expect(r).toMatchObject({ ok: false, kind: 'conflict', reason: 'already_subscribed' });
    }
  });

  it('every other action without a subscription is not_found', () => {
    for (const action of actions.filter((a) => a !== 'subscribe')) {
      expect(decide(action, null, NOW)).toMatchObject({ ok: false, kind: 'not_found' });
    }
  });

  it('classifies refusals: conflict (409) for state, validation (400) for immediate cancel outside past_due', () => {
    const snap = (status: SubscriptionStatus, extra: Partial<SubscriptionSnapshot> = {}): SubscriptionSnapshot => ({
      status,
      cancelAtPeriodEnd: false,
      hasPendingPlan: false,
      currentPeriodEnd: END_FUTURE,
      ...extra,
    });
    expect(decide('cancel', snap('paused'), NOW)).toMatchObject({ ok: false, kind: 'conflict', reason: 'cancel_while_paused' });
    expect(decide('cancel', snap('active', { cancelAtPeriodEnd: true }), NOW)).toMatchObject({ kind: 'conflict', reason: 'already_canceling' });
    expect(decide('cancelImmediate', snap('active'), NOW)).toMatchObject({ ok: false, kind: 'validation', reason: 'immediate_requires_past_due' });
    expect(decide('reactivate', snap('active'), NOW)).toMatchObject({ kind: 'conflict', reason: 'not_canceling' });
    expect(decide('reactivate', snap('paused', { cancelAtPeriodEnd: true }), NOW)).toMatchObject({ kind: 'conflict', reason: 'reactivate_while_paused' });
    expect(decide('reactivate', snap('active', { cancelAtPeriodEnd: true, currentPeriodEnd: END_PAST }), NOW)).toMatchObject({ kind: 'conflict', reason: 'period_already_ended' });
    expect(decide('removePendingChange', snap('active'), NOW)).toMatchObject({ kind: 'conflict', reason: 'no_pending_change' });
  });

  it('upgrade and pause are refused once the period has ended but renewal has not run (renewal_due); cancel/downgrade still work', () => {
    const due: SubscriptionSnapshot = { status: 'active', cancelAtPeriodEnd: false, hasPendingPlan: false, currentPeriodEnd: NOW };
    expect(decide('upgrade', due, NOW)).toMatchObject({ ok: false, kind: 'conflict', reason: 'renewal_due' });
    expect(decide('pause', due, NOW)).toMatchObject({ ok: false, kind: 'conflict', reason: 'renewal_due' });
    expect(decide('cancel', due, NOW).ok).toBe(true);
    expect(decide('downgrade', due, NOW).ok).toBe(true);
    const justBefore = { ...due, currentPeriodEnd: new Date(NOW.getTime() + 1) };
    expect(decide('upgrade', justBefore, NOW).ok).toBe(true);
    expect(decide('pause', justBefore, NOW).ok).toBe(true);
  });

  it('a pending downgrade survives pause (downgrade/remove allowed while paused)', () => {
    const paused: SubscriptionSnapshot = { status: 'paused', cancelAtPeriodEnd: false, hasPendingPlan: true, currentPeriodEnd: END_FUTURE };
    expect(decide('downgrade', paused, NOW).ok).toBe(true);
    expect(decide('removePendingChange', paused, NOW).ok).toBe(true);
  });
});

describe('MockProvider', () => {
  const input = (key: string, amountCents = 1000) => ({ amountCents, idempotencyKey: key, userId: 'u', subscriptionId: 's', description: 'd' });

  it('succeeds by default and returns a deterministic reference', async () => {
    const a = new MockProvider();
    const b = new MockProvider();
    const ra = await a.charge(input('k1'));
    expect(ra.status).toBe('succeeded');
    expect(await b.charge(input('k1'))).toEqual(ra);
  });

  it('honors idempotency: same key returns the same result without a second charge', async () => {
    const p = new MockProvider();
    const first = await p.charge(input('k'));
    const second = await p.charge(input('k'));
    expect(second).toEqual(first);
    expect(p.chargeCalls).toBe(2);
    expect(p.processedCharges).toBe(1);
  });

  it('a replayed decline stays declined for the same key; a new key can succeed', async () => {
    const p = new MockProvider();
    p.declineNext();
    expect((await p.charge(input('k1'))).status).toBe('failed');
    expect((await p.charge(input('k1'))).status).toBe('failed');
    expect((await p.charge(input('k2'))).status).toBe('succeeded');
    expect(p.processedCharges).toBe(1);
  });

  it('rejects reuse of a key with a different amount, and non-positive amounts', async () => {
    const p = new MockProvider();
    await p.charge(input('k', 1000));
    expect(await p.charge(input('k', 2000))).toMatchObject({ status: 'failed', errorCode: 'idempotency_key_reused' });
    expect(await p.charge(input('z', 0))).toMatchObject({ status: 'failed', errorCode: 'invalid_amount' });
    expect(await p.charge(input('y', -5))).toMatchObject({ status: 'failed', errorCode: 'invalid_amount' });
  });

  it("failure modes: 'always' declines everything, 'never' nothing", async () => {
    const p = new MockProvider({ failMode: { kind: 'always' } });
    expect(await p.charge(input('a'))).toMatchObject({ status: 'failed', errorCode: 'card_declined' });
    p.setFailMode({ kind: 'never' });
    expect((await p.charge(input('b'))).status).toBe('succeeded');
  });

  it("'random:p' is a deterministic function of the key", async () => {
    const run = async () => {
      const p = new MockProvider({ failMode: { kind: 'random', probability: 0.3 } });
      const out: string[] = [];
      for (let i = 0; i < 300; i++) out.push((await p.charge(input(`key-${i}`))).status);
      return out;
    };
    const a = await run();
    expect(await run()).toEqual(a);
    const failures = a.filter((s) => s === 'failed').length;
    expect(failures).toBeGreaterThan(50);
    expect(failures).toBeLessThan(130);
  });

  it('simulates a lost response: money is taken, the caller sees an error, lookup knows the truth', async () => {
    const p = new MockProvider();
    p.loseNextResponses();
    await expect(p.charge(input('k'))).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(p.processedCharges).toBe(1);
    expect(await p.lookup('k')).toMatchObject({ status: 'succeeded', amountCents: 1000 });
    // retrying with the SAME key returns the stored result and does not charge again
    expect((await p.charge(input('k'))).status).toBe('succeeded');
    expect(p.processedCharges).toBe(1);
  });

  it('simulates a dropped request: nothing is taken and lookup returns null', async () => {
    const p = new MockProvider();
    p.dropNextRequests();
    await expect(p.charge(input('k'))).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(p.processedCharges).toBe(0);
    expect(await p.lookup('k')).toBeNull();
  });

  it('looks up declined charges too', async () => {
    const p = new MockProvider({ failMode: { kind: 'always' } });
    await p.charge(input('k'));
    expect(await p.lookup('k')).toMatchObject({ status: 'failed', errorCode: 'card_declined' });
  });

  it('refunds are idempotent, bounded by the charged amount, and need a real charge', async () => {
    const p = new MockProvider();
    const charge = await p.charge(input('c', 1000));
    if (charge.status !== 'succeeded') throw new Error('expected success');
    const r1 = await p.refund({ providerReference: charge.providerReference, amountCents: 600, idempotencyKey: 'r1' });
    expect(r1.status).toBe('succeeded');
    expect(await p.refund({ providerReference: charge.providerReference, amountCents: 600, idempotencyKey: 'r1' })).toEqual(r1);
    expect(p.processedRefunds).toBe(1);
    expect(await p.refund({ providerReference: charge.providerReference, amountCents: 600, idempotencyKey: 'r2' })).toMatchObject({ status: 'failed', errorCode: 'invalid_refund_amount' });
    expect(await p.refund({ providerReference: 'nope', amountCents: 1, idempotencyKey: 'r3' })).toMatchObject({ status: 'failed', errorCode: 'unknown_charge' });
  });

  it('parses MOCK_BILLING_FAIL', () => {
    expect(parseMockFailMode(undefined)).toEqual({ kind: 'never' });
    expect(parseMockFailMode('never')).toEqual({ kind: 'never' });
    expect(parseMockFailMode('ALWAYS')).toEqual({ kind: 'always' });
    expect(parseMockFailMode('random:0.3')).toEqual({ kind: 'random', probability: 0.3 });
    expect(parseMockFailMode('random:1')).toEqual({ kind: 'random', probability: 1 });
    for (const bad of ['random', 'random:2', 'random:-1', 'sometimes', 'random:abc']) expect(() => parseMockFailMode(bad)).toThrow(/MOCK_BILLING_FAIL/);
  });

  it('the Stripe stub is an unimplemented, non-authoritative integration point', async () => {
    const s = new StripeProvider();
    expect(s.lookupIsAuthoritative).toBe(false);
    await expect(s.charge(input('k'))).rejects.toThrow(/not implemented/);
  });
});
