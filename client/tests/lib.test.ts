import { describe, expect, it } from 'vitest';
import type { BillingOperation, HistoryEvent, Subscription, SubscriptionStatus } from '../src/api/types';
import { invoiceStatus, operationLabel, operationStatus } from '../src/lib/billing';
import { describeEvent } from '../src/lib/events';
import { formatDate, formatDateTime, formatDuration, formatLimit, formatMoney, formatPrice, metricLabel } from '../src/lib/format';
import { clearSession, loadSession, saveSession } from '../src/lib/storage';
import { allowedActions, phaseOf } from '../src/lib/subscriptionState';
import { PRO, makeSub, plans } from './mockApi';

describe('phaseOf: driven only by the server\'s status and accessAllowed (never by dates)', () => {
  const cases: [SubscriptionStatus, boolean, string][] = [
    ['active', true, 'active'],
    ['active', false, 'renewal_processing'], // B19: period ended, renewal not processed yet
    ['past_due', true, 'grace'],
    ['past_due', false, 'grace_expired'],
    ['paused', false, 'paused'],
    ['canceled', false, 'canceled'],
  ];
  it.each(cases)('%s with accessAllowed=%s is %s', (status, accessAllowed, phase) => {
    expect(phaseOf({ status, accessAllowed })).toBe(phase);
  });

  it('ignores every date field: an "expired-looking" period with accessAllowed=true is still active', () => {
    const sub = makeSub({ currentPeriodEnd: '2000-01-01T00:00:00.000Z', accessAllowed: true });
    expect(phaseOf(sub)).toBe('active');
  });
});

describe('allowedActions mirrors the backend transition table (as hints)', () => {
  const state = (o: Partial<Subscription>) => allowedActions(makeSub(o));

  it('active: upgrade, downgrade, pause, cancel allowed; resume and reactivate not', () => {
    const a = state({});
    expect([a.upgrade.allowed, a.downgrade.allowed, a.pause.allowed, a.cancel.allowed]).toEqual([true, true, true, true]);
    expect([a.resume.allowed, a.reactivate.allowed, a.cancelImmediate.allowed, a.removePendingChange.allowed]).toEqual([false, false, false, false]);
  });

  it('renewal processing (period ended): upgrade and pause wait for renewal; cancel and downgrade still work', () => {
    const a = state({ accessAllowed: false });
    expect(a.upgrade).toMatchObject({ allowed: false, reason: expect.stringMatching(/renewal/i) });
    expect(a.pause.allowed).toBe(false);
    expect(a.cancel.allowed).toBe(true);
    expect(a.downgrade.allowed).toBe(true);
  });

  it('paused: only resume, downgrade and pending-change removal; cancel is explained', () => {
    const a = state({ status: 'paused', accessAllowed: false, pendingPlan: plans[0]! });
    expect([a.resume.allowed, a.downgrade.allowed, a.removePendingChange.allowed]).toEqual([true, true, true]);
    expect([a.upgrade.allowed, a.pause.allowed, a.cancel.allowed]).toEqual([false, false, false]);
    expect(a.cancel.reason).toMatch(/resume/i);
  });

  it('past_due: cancel (with grace) and immediate cancel allowed; upgrade/pause/downgrade not', () => {
    const a = state({ status: 'past_due' });
    expect([a.cancel.allowed, a.cancelImmediate.allowed]).toEqual([true, true]);
    expect([a.upgrade.allowed, a.pause.allowed, a.downgrade.allowed]).toEqual([false, false, false]);
  });

  it('a scheduled cancellation offers reactivate instead of cancel (not while paused)', () => {
    const active = state({ cancelAtPeriodEnd: true });
    expect([active.reactivate.allowed, active.cancel.allowed]).toEqual([true, false]);
    expect(state({ cancelAtPeriodEnd: true, status: 'past_due' }).reactivate.allowed).toBe(true);
    expect(state({ cancelAtPeriodEnd: true, status: 'paused', accessAllowed: false }).reactivate.reason).toMatch(/resume/i);
  });
});

describe('formatting', () => {
  it('formats paise as INR, hiding .00', () => {
    expect(formatMoney(49_900)).toBe('₹499');
    expect(formatMoney(33_803)).toBe('₹338.03');
    expect(formatMoney(0)).toBe('₹0');
    expect(formatMoney(149_900)).toBe('₹1,499');
    expect(formatPrice(0, 'month')).toBe('Free');
    expect(formatPrice(499_900, 'year')).toBe('₹4,999 / year');
  });
  it('formats dates in UTC and says so', () => {
    expect(formatDate('2026-02-01T00:00:00.000Z')).toBe('1 Feb 2026 UTC');
    expect(formatDateTime('2026-02-01T23:30:00.000Z')).toBe('1 Feb 2026, 23:30 UTC');
    expect(formatDateTime('2026-02-01T00:00:00.000Z')).toContain('00:00 UTC');
  });
  it('formats durations, metrics and limits', () => {
    expect(formatDuration(21 * 86_400_000)).toBe('21 days');
    expect(formatDuration(86_400_000 + 3 * 3_600_000)).toBe('1 day 3 h');
    expect(formatDuration(5 * 3_600_000 + 10 * 60_000)).toBe('5 h 10 min');
    expect(metricLabel('api_calls')).toBe('API calls');
    expect(metricLabel('storage_gb')).toBe('Storage gb');
    expect(formatLimit(null)).toBe('Unlimited');
    expect(formatLimit(50_000)).toBe('50,000');
  });
});

describe('billing status wording keeps pending, failed, paid and refunded distinct', () => {
  const op = (o: Partial<BillingOperation>): BillingOperation => ({
    id: 'op-1', type: 'charge', status: 'succeeded', kind: 'upgrade', amountCents: 100, attempt: 1, reason: null, errorMessage: null, invoiceId: null, refundOfOperationId: null, createdAt: '', updatedAt: '', ...o,
  });

  it('invoices', () => {
    expect(invoiceStatus('paid')).toMatchObject({ label: 'Paid', tone: 'good' });
    expect(invoiceStatus('failed')).toMatchObject({ label: 'Payment failed', tone: 'bad' });
    expect(invoiceStatus('refunded')).toMatchObject({ label: 'Refunded', tone: 'neutral' });
  });

  it('a pending charge is never presented as paid', () => {
    const s = operationStatus(op({ status: 'pending' }));
    expect(s.label).toBe('In progress');
    expect(s.note).toMatch(/not counted as paid/i);
  });

  it('a failed charge shows the provider message; a succeeded one is plain', () => {
    expect(operationStatus(op({ status: 'failed', errorMessage: 'card_declined: The payment was declined' }))).toMatchObject({ label: 'Failed', tone: 'bad', note: 'card_declined: The payment was declined' });
    expect(operationStatus(op({ status: 'succeeded' })).label).toBe('Succeeded');
  });

  it('refunds: pending, succeeded and FAILED are distinct, and a failed refund is flagged with a reference', () => {
    expect(operationStatus(op({ type: 'refund', status: 'pending' })).label).toBe('Refund pending');
    expect(operationStatus(op({ type: 'refund', status: 'succeeded' })).label).toBe('Refunded');
    const failed = operationStatus(op({ type: 'refund', status: 'failed', id: 'ref-9', errorMessage: 'refund_not_allowed: no' }));
    expect(failed).toMatchObject({ label: 'Refund failed', tone: 'bad' });
    expect(failed.note).toMatch(/needs attention/i);
    expect(failed.note).toContain('ref-9');
    expect(operationLabel(op({ type: 'refund', kind: 'renewal' }))).toBe('Refund of renewal payment');
  });
});

describe('describeEvent covers every backend event type', () => {
  const plansById = new Map(plans.map((p) => [p.id, p]));
  const ev = (type: string, meta: Record<string, unknown> = {}): HistoryEvent => ({ id: type, subscriptionId: 's', type, fromStatus: null, toStatus: null, meta, createdAt: '2026-01-01T00:00:00.000Z' });

  it.each([
    ['subscribed', { plan_id: PRO.id, amount_cents: 49_900 }, 'Subscribed to Pro', 'good'],
    ['upgraded', { to_plan_id: 'plan-biz', amount_cents: 67_742 }, 'Upgraded to Business', 'good'],
    ['downgrade_scheduled', { to_plan_id: 'plan-free', effective_at: '2026-02-01T00:00:00Z' }, 'Downgrade to Free scheduled', 'neutral'],
    ['downgrade_cleared', { reason: 'upgrade' }, 'Scheduled downgrade removed', 'neutral'],
    ['downgrade_applied', { to_plan_id: 'plan-free' }, 'Moved to Free', 'neutral'],
    ['paused', {}, 'Subscription paused', 'neutral'],
    ['resumed', { new_period_end: '2026-02-10T00:00:00Z' }, 'Subscription resumed', 'good'],
    ['cancel_scheduled', { effective_at: '2026-02-01T00:00:00Z' }, 'Cancellation scheduled', 'warn'],
    ['reactivated', {}, 'Cancellation undone', 'good'],
    ['renewed', { amount_cents: 49_900, period_end: '2026-03-01T00:00:00Z' }, 'Subscription renewed', 'good'],
    ['renewal_failed', { grace_ends_at: '2026-02-04T00:00:00Z' }, 'Renewal payment failed', 'bad'],
    ['canceled', { reason: 'payment_failed' }, 'Subscription canceled', 'bad'],
    ['charge_discarded', { amount_cents: 33_803 }, 'Payment refunded', 'warn'],
  ])('%s', (type, meta, title, tone) => {
    const d = describeEvent(ev(type, meta), plansById);
    expect(d.title).toBe(title);
    expect(d.tone).toBe(tone);
  });

  it('adds meaningful detail: amounts, dates, recovery, final failure, cancel reason', () => {
    expect(describeEvent(ev('upgraded', { to_plan_id: 'plan-biz', amount_cents: 67_742 }), plansById).detail).toContain('₹677.42');
    expect(describeEvent(ev('renewed', { amount_cents: 49_900, period_end: '2026-03-01T00:00:00Z', recovered_from_past_due: true }), plansById).detail).toMatch(/Recovered after a failed payment/);
    expect(describeEvent(ev('renewal_failed', { final: true, amount_cents: 49_900 }), plansById)).toMatchObject({ title: 'Final renewal payment failed' });
    expect(describeEvent(ev('canceled', { reason: 'payment_failed' }), plansById).detail).toMatch(/after the renewal payment failed/);
    expect(describeEvent(ev('canceled', { immediate: true, reason: 'user_requested' }), plansById).detail).toMatch(/immediately/);
    expect(describeEvent(ev('charge_discarded', { amount_cents: 100 }), plansById).detail).toMatch(/refund/i);
  });

  it('degrades gracefully for unknown types or missing plans', () => {
    expect(describeEvent(ev('something_new'), plansById).title).toBe('something new');
    expect(describeEvent(ev('upgraded', { to_plan_id: 'gone' }), plansById).title).toBe('Upgraded to a plan');
  });
});

describe('session storage', () => {
  it('round-trips a token and clears it', () => {
    saveSession({ token: 'abc' });
    expect(loadSession()).toEqual({ token: 'abc' });
    clearSession();
    expect(loadSession()).toBeNull();
  });
  it('treats corrupt or malformed data as signed out, and survives a broken storage', () => {
    window.localStorage.setItem('subcycle.session', '{not json');
    expect(loadSession()).toBeNull();
    window.localStorage.setItem('subcycle.session', JSON.stringify({ token: 5 }));
    expect(loadSession()).toBeNull();
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => { throw new Error('denied'); } } as unknown as Storage;
    expect(loadSession(broken)).toBeNull();
    expect(() => saveSession({ token: 'x' }, broken)).not.toThrow();
    expect(() => clearSession(broken)).not.toThrow();
  });
});
