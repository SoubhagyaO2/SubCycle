import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Subscription } from '../src/api/types';
import { BIZ, FREE, PRO, deferred, err, makeSub, renderApp, signIn, signedInApi, type MockApi } from './mockApi';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Renders a page with a LIVE subscription holder, so mutations followed by a refetch show the server's new state. */
async function open(path: string, initial: Subscription | null, heading: string) {
  signIn();
  const state = { sub: initial };
  const api = signedInApi(initial);
  api.on('GET /subscriptions/current', () => (state.sub ? { body: { subscription: state.sub } } : err(404, 'SUBSCRIPTION_NOT_FOUND', 'No active subscription found')));
  api.install();
  renderApp(path);
  await screen.findByRole('heading', { name: heading });
  return { api, state };
}
const keyOf = (api: MockApi, route: string, index = 0) => api.callsTo(route)[index]!.headers['idempotency-key'];
const dialog = () => screen.getByRole('dialog');
/** Clicks a button INSIDE the open dialog (the page behind it can have a button with the same name). */
const click = (name: string | RegExp) => userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name }));

describe('Plans page: subscribe', () => {
  it('lists the plans returned by the API with prices and limits', async () => {
    await open('/pricing', null, 'Plans');
    const free = await screen.findByRole('article', { name: 'Free' });
    expect(within(free).getByText('Free', { selector: 'span' })).toBeInTheDocument();
    expect(within(free).getByText(/100/)).toBeInTheDocument();
    const pro = screen.getByRole('article', { name: 'Pro' });
    expect(within(pro).getByText('₹499')).toBeInTheDocument();
    expect(within(screen.getByRole('article', { name: 'Pro (Yearly)' })).getByText('₹4,999')).toBeInTheDocument();
    expect(within(screen.getByRole('article', { name: 'Business' })).getByText((_, el) => el?.tagName === 'LI' && /50,000 api calls per month/i.test(el.textContent ?? ''))).toBeInTheDocument();
  });

  it('subscribe: confirmation states the charge; success is shown only AFTER the API confirms', async () => {
    const gate = deferred();
    const { api, state } = await open('/pricing', null, 'Plans');
    api.on('POST /subscriptions', () => {
      state.sub = makeSub();
      return { status: 201, body: { subscription: state.sub }, gate: gate.promise };
    });
    await userEvent.click((await screen.findAllByRole('button', { name: 'Subscribe' }))[0]!); // Pro (cheapest paid is first Subscribe)
    expect(dialog()).toHaveTextContent('You will be charged ₹499 now');
    await click(/Pay ₹499 and subscribe/);

    // in flight: still on the dialog, busy, and NO success claim
    expect(await screen.findByRole('button', { name: /Pay ₹499 and subscribe/ })).toBeDisabled();
    expect(screen.queryByText(/you're subscribed/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Dashboard' })).not.toBeInTheDocument();

    gate.resolve();
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.getByText("You're subscribed to Pro.")).toBeInTheDocument();
    const call = api.callsTo('POST /subscriptions')[0]!;
    expect(call.body).toEqual({ planId: PRO.id });
    expect(call.headers['idempotency-key']).toMatch(/^[\x21-\x7E]{1,255}$/);
    expect(call.headers.authorization).toBe('Bearer test-token');
  });

  it('the free plan needs no payment', async () => {
    const { api, state } = await open('/pricing', null, 'Plans');
    api.on('POST /subscriptions', () => ({ status: 201, body: { subscription: (state.sub = makeSub({ plan: FREE })) } }));
    await userEvent.click(await screen.findByRole('button', { name: 'Start for free' }));
    expect(dialog()).toHaveTextContent('costs nothing');
    await click('Start for free');
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
  });

  it('double clicks on confirm create exactly one request', async () => {
    const gate = deferred();
    const { api } = await open('/pricing', null, 'Plans');
    api.on('POST /subscriptions', { status: 201, body: { subscription: makeSub() }, gate: gate.promise });
    await userEvent.click((await screen.findAllByRole('button', { name: 'Subscribe' }))[0]!);
    const confirm = screen.getByRole('button', { name: /Pay ₹499/ });
    await userEvent.dblClick(confirm);
    await userEvent.click(confirm);
    gate.resolve();
    await screen.findByRole('heading', { name: 'Dashboard' });
    expect(api.callsTo('POST /subscriptions')).toHaveLength(1);
  });

  it('a declined payment shows the server message, changes nothing, and a retry is a NEW intention with a NEW key', async () => {
    const { api, state } = await open('/pricing', null, 'Plans');
    api.on('POST /subscriptions', err(402, 'PAYMENT_FAILED', 'Your payment was declined. Nothing was changed; you can try again.'));
    await userEvent.click((await screen.findAllByRole('button', { name: 'Subscribe' }))[0]!);
    await click(/Pay ₹499/);
    expect(await within(dialog()).findByRole('alert')).toHaveTextContent('Your payment was declined');
    expect(screen.queryByText(/you're subscribed/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Dashboard' })).not.toBeInTheDocument();

    api.on('POST /subscriptions', () => ({ status: 201, body: { subscription: (state.sub = makeSub()) } }));
    await click(/Pay ₹499/);
    await screen.findByRole('heading', { name: 'Dashboard' });
    expect(keyOf(api, 'POST /subscriptions', 1)).not.toBe(keyOf(api, 'POST /subscriptions', 0));
  });

  it('an unknown outcome (network drop) is explained and the retry reuses the SAME Idempotency-Key', async () => {
    const { api, state } = await open('/pricing', null, 'Plans');
    api.on('POST /subscriptions', { networkError: true });
    await userEvent.click((await screen.findAllByRole('button', { name: 'Subscribe' }))[0]!);
    await click(/Pay ₹499/);
    expect(await within(dialog()).findByRole('alert')).toHaveTextContent('Cannot reach the server');
    expect(dialog()).toHaveTextContent('Retrying is safe: you will not be charged twice');

    api.on('POST /subscriptions', () => ({ status: 201, body: { subscription: (state.sub = makeSub()) } }));
    await click('Retry');
    await screen.findByRole('heading', { name: 'Dashboard' });
    expect(api.callsTo('POST /subscriptions')).toHaveLength(2);
    expect(keyOf(api, 'POST /subscriptions', 1)).toBe(keyOf(api, 'POST /subscriptions', 0));
  });

  it('"still being confirmed" (409) keeps the key too; cancelling the dialog sends nothing', async () => {
    const { api, state } = await open('/pricing', null, 'Plans');
    api.on('POST /subscriptions', err(409, 'OPERATION_IN_PROGRESS', 'Your payment is still being confirmed. Please retry shortly; you will not be charged twice.'));
    await userEvent.click((await screen.findAllByRole('button', { name: 'Subscribe' }))[0]!);
    await click(/Pay ₹499/);
    expect(await within(dialog()).findByRole('alert')).toHaveTextContent('still being confirmed');
    api.on('POST /subscriptions', () => ({ status: 201, body: { subscription: (state.sub = makeSub()) } }));
    await click('Retry');
    await screen.findByRole('heading', { name: 'Dashboard' });
    expect(keyOf(api, 'POST /subscriptions', 1)).toBe(keyOf(api, 'POST /subscriptions', 0));
  });

  it('cancel closes the dialog without calling the API', async () => {
    const { api } = await open('/pricing', null, 'Plans');
    await userEvent.click((await screen.findAllByRole('button', { name: 'Subscribe' }))[0]!);
    await click('Cancel');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.callsTo('POST /subscriptions')).toHaveLength(0);
  });

  it('with a subscription: marks the current plan, links upgrade/downgrade, and explains the yearly limitation', async () => {
    await open('/pricing', makeSub({ plan: PRO, pendingPlan: FREE }), 'Plans');
    expect(within(await screen.findByRole('article', { name: 'Pro' })).getByText('Current plan')).toBeInTheDocument();
    expect(within(screen.getByRole('article', { name: 'Free' })).getByText('Scheduled')).toBeInTheDocument();
    expect(within(screen.getByRole('article', { name: 'Business' })).getByRole('link', { name: 'Upgrade' })).toHaveAttribute('href', `/manage?plan=${BIZ.id}`);
    expect(within(screen.getByRole('article', { name: 'Pro (Yearly)' })).getByText(/not supported yet/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Subscribe' })).not.toBeInTheDocument();
  });
});

describe('Manage plan: upgrade with a server-side preview', () => {
  it('previews, confirms with an Idempotency-Key, and shows success only after the API answered', async () => {
    const gate = deferred();
    const { api, state } = await open('/manage', makeSub(), 'Manage plan');
    api.on('GET /subscriptions/upgrade-preview', {
      body: {
        preview: { fromPlan: PRO, toPlan: BIZ, amountCents: 67_742, chargeRequired: true, remainingMs: 21 * 86_400_000, totalMs: 31 * 86_400_000, periodStart: '2026-01-01T00:00:00.000Z', periodEnd: '2026-02-01T00:00:00.000Z', computedAt: '2026-01-11T00:00:00.000Z' },
      },
    });
    api.on('POST /subscriptions/upgrade', () => {
      state.sub = makeSub({ plan: BIZ });
      return { body: { subscription: state.sub }, gate: gate.promise };
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Upgrade to Business' }));
    expect(await within(dialog()).findByText('₹677.42')).toBeInTheDocument();
    expect(api.callsTo('GET /subscriptions/upgrade-preview')[0]!.query).toEqual({ planId: BIZ.id });
    expect(dialog()).toHaveTextContent('21 days of 31 days');
    expect(dialog()).toHaveTextContent(/This is an estimate/);

    await click('Confirm and pay ₹677.42');
    expect(await screen.findByRole('button', { name: 'Confirm and pay ₹677.42' })).toBeDisabled();
    expect(screen.queryByText(/You are now on Business/)).not.toBeInTheDocument(); // never assume it worked
    expect(within(screen.getByRole('region', { name: 'Current plan' })).getByText('Pro')).toBeInTheDocument();

    gate.resolve();
    expect(await screen.findByText('You are now on Business.')).toBeInTheDocument();
    await waitFor(() => expect(within(screen.getByRole('region', { name: 'Current plan' })).getByText('Business')).toBeInTheDocument());
    expect(api.callsTo('POST /subscriptions/upgrade')[0]!.body).toEqual({ planId: BIZ.id });
    expect(keyOf(api, 'POST /subscriptions/upgrade')).toMatch(/^[\x21-\x7E]{1,255}$/);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('confirm stays disabled until the preview has loaded, and a zero amount is described as no charge', async () => {
    const gate = deferred();
    const { api } = await open('/manage', makeSub(), 'Manage plan');
    api.on('GET /subscriptions/upgrade-preview', { gate: gate.promise, body: { preview: { fromPlan: PRO, toPlan: BIZ, amountCents: 0, chargeRequired: false, remainingMs: 1, totalMs: 2_678_400_000, periodStart: 'a', periodEnd: 'b', computedAt: 'c' } } });
    await userEvent.click(await screen.findByRole('button', { name: 'Upgrade to Business' }));
    expect(await within(dialog()).findByText(/Calculating the upgrade price/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm upgrade' })).toBeDisabled();
    gate.resolve();
    expect(await within(dialog()).findByText('No charge')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm upgrade' })).toBeEnabled();
  });

  it('a preview error (e.g. renewal due) is shown and blocks the confirmation', async () => {
    const { api } = await open('/manage', makeSub(), 'Manage plan');
    api.on('GET /subscriptions/upgrade-preview', err(409, 'INVALID_TRANSITION', 'Your billing period has ended and renewal is being processed. Please try again shortly.', { reason: 'renewal_due' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Upgrade to Business' }));
    expect(await within(dialog()).findByText(/renewal is being processed/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm upgrade' })).toBeDisabled();
  });

  async function startUpgrade(api: MockApi) {
    api.on('GET /subscriptions/upgrade-preview', { body: { preview: { fromPlan: PRO, toPlan: BIZ, amountCents: 67_742, chargeRequired: true, remainingMs: 1, totalMs: 2, periodStart: 'a', periodEnd: 'b', computedAt: 'c' } } });
    await userEvent.click(await screen.findByRole('button', { name: 'Upgrade to Business' }));
    await within(dialog()).findByText('₹677.42');
  }

  it('a declined upgrade leaves the plan unchanged, shows the message, and the retry uses a new key', async () => {
    const { api, state } = await open('/manage', makeSub(), 'Manage plan');
    await startUpgrade(api);
    api.on('POST /subscriptions/upgrade', err(402, 'PAYMENT_FAILED', 'Your payment was declined. Nothing was changed; you can try again.'));
    await click('Confirm and pay ₹677.42');
    expect(await within(dialog()).findByRole('alert')).toHaveTextContent('Your payment was declined');
    expect(screen.queryByText(/You are now on/)).not.toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Current plan' })).getByText('Pro')).toBeInTheDocument();

    api.on('POST /subscriptions/upgrade', () => ({ body: { subscription: (state.sub = makeSub({ plan: BIZ })) } }));
    await click('Confirm and pay ₹677.42');
    expect(await screen.findByText('You are now on Business.')).toBeInTheDocument();
    expect(keyOf(api, 'POST /subscriptions/upgrade', 1)).not.toBe(keyOf(api, 'POST /subscriptions/upgrade', 0));
  });

  it('a lost response / "still confirming" is retried with the SAME key (cannot double charge)', async () => {
    const { api, state } = await open('/manage', makeSub(), 'Manage plan');
    await startUpgrade(api);
    api.on('POST /subscriptions/upgrade', { networkError: true });
    await click('Confirm and pay ₹677.42');
    expect(await within(dialog()).findByRole('alert')).toHaveTextContent('Cannot reach the server');
    api.on('POST /subscriptions/upgrade', err(409, 'OPERATION_IN_PROGRESS', 'Your payment is still being confirmed. Please retry shortly; you will not be charged twice.'));
    await click('Retry');
    expect(await within(dialog()).findByRole('alert')).toHaveTextContent('still being confirmed');
    api.on('POST /subscriptions/upgrade', () => ({ body: { subscription: (state.sub = makeSub({ plan: BIZ })) } }));
    await click('Retry');
    expect(await screen.findByText('You are now on Business.')).toBeInTheDocument();
    const keys = api.callsTo('POST /subscriptions/upgrade').map((c) => c.headers['idempotency-key']);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
  });

  it('STATE_CHANGED (charge refunded) is shown as the server worded it, and the screen re-syncs', async () => {
    const { api } = await open('/manage', makeSub(), 'Manage plan');
    await startUpgrade(api);
    const before = api.callsTo('GET /subscriptions/current').length;
    api.on('POST /subscriptions/upgrade', err(409, 'STATE_CHANGED', 'Your subscription changed while the payment was processing. The charge will be refunded.'));
    await click('Confirm and pay ₹677.42');
    expect(await within(dialog()).findByRole('alert')).toHaveTextContent('The charge will be refunded');
    await waitFor(() => expect(api.callsTo('GET /subscriptions/current').length).toBeGreaterThan(before));
  });

  it('double clicking confirm sends one upgrade; and while it is in flight no other billing action can start', async () => {
    const gate = deferred();
    const { api, state } = await open('/manage', makeSub(), 'Manage plan');
    await startUpgrade(api);
    api.on('POST /subscriptions/upgrade', () => ({ body: { subscription: (state.sub = makeSub({ plan: BIZ })) }, gate: gate.promise }));
    const confirm = screen.getByRole('button', { name: 'Confirm and pay ₹677.42' });
    await userEvent.dblClick(confirm);
    await userEvent.click(confirm);
    // other actions on the page are disabled while busy
    expect(screen.getByRole('button', { name: 'Pause subscription' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel at end of period' })).toBeDisabled();
    gate.resolve();
    await screen.findByText('You are now on Business.');
    expect(api.callsTo('POST /subscriptions/upgrade')).toHaveLength(1);
  });

  it('the Plans page deep link (?plan=) opens the right dialog', async () => {
    const { api } = await open('/pricing', makeSub(), 'Plans');
    api.on('GET /subscriptions/upgrade-preview', { body: { preview: { fromPlan: PRO, toPlan: BIZ, amountCents: 100, chargeRequired: true, remainingMs: 1, totalMs: 2, periodStart: 'a', periodEnd: 'b', computedAt: 'c' } } });
    await userEvent.click(await screen.findByRole('link', { name: 'Upgrade' }));
    expect(await screen.findByRole('dialog', { name: 'Upgrade to Business' })).toBeInTheDocument();
  });
});

describe('Manage plan: downgrade, pause/resume, cancel, reactivate', () => {
  it('schedules a downgrade (effective at period end) and shows the server\'s scheduled state', async () => {
    const { api, state } = await open('/manage', makeSub({ plan: BIZ }), 'Manage plan');
    api.on('POST /subscriptions/downgrade', () => ({ body: { subscription: (state.sub = makeSub({ plan: BIZ, pendingPlan: PRO })) } }));
    await userEvent.click(await screen.findByRole('button', { name: 'Schedule downgrade to Pro' }));
    expect(dialog()).toHaveTextContent('You will move to Pro on 1 Feb 2026 UTC');
    expect(dialog()).toHaveTextContent('keep Business');
    await click('Schedule downgrade');
    expect(await screen.findByText(/Downgrade to Pro is scheduled for 1 Feb 2026 UTC. You keep Business until then./)).toBeInTheDocument();
    expect(api.callsTo('POST /subscriptions/downgrade')[0]!.body).toEqual({ planId: PRO.id });
    expect(await screen.findByText('Scheduled change to Pro')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Already scheduled' })).toBeDisabled();
  });

  it('removes a scheduled downgrade with DELETE', async () => {
    const { api, state } = await open('/manage', makeSub({ plan: BIZ, pendingPlan: PRO }), 'Manage plan');
    api.on('DELETE /subscriptions/pending-change', () => ({ body: { subscription: (state.sub = makeSub({ plan: BIZ })) } }));
    await userEvent.click(await screen.findByRole('button', { name: 'Keep my current plan instead' }));
    await click('Keep current plan');
    expect(await screen.findByText(/Your scheduled change was removed/)).toBeInTheDocument();
    expect(api.callsTo('DELETE /subscriptions/pending-change')).toHaveLength(1);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Keep my current plan instead' })).not.toBeInTheDocument());
  });

  it('pause then resume follow the server state', async () => {
    const { api, state } = await open('/manage', makeSub(), 'Manage plan');
    api.on('POST /subscriptions/pause', () => ({ body: { subscription: (state.sub = makeSub({ status: 'paused', accessAllowed: false, pausedAt: '2026-01-10T00:00:00.000Z' })) } }));
    await userEvent.click(await screen.findByRole('button', { name: 'Pause subscription' }));
    await click('Pause subscription');
    expect(await screen.findByText('Your subscription is paused.')).toBeInTheDocument();
    expect(await screen.findByText('Your subscription is paused', { selector: 'p' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pause subscription' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Upgrade to Business' })).toBeDisabled();

    api.on('POST /subscriptions/resume', () => ({ body: { subscription: (state.sub = makeSub({ currentPeriodEnd: '2026-02-10T00:00:00.000Z' })) } }));
    await userEvent.click(screen.getByRole('button', { name: 'Resume subscription' }));
    await click('Resume subscription');
    expect(await screen.findByText(/active again. Your current period now ends 10 Feb 2026 UTC/)).toBeInTheDocument();
  });

  it('cancel at period end: explains the effect, sends no body, and reflects the scheduled cancellation', async () => {
    const { api, state } = await open('/manage', makeSub(), 'Manage plan');
    api.on('POST /subscriptions/cancel', () => ({ body: { subscription: (state.sub = makeSub({ cancelAtPeriodEnd: true, cancelRequestedAt: '2026-01-10T00:00:00.000Z' })) } }));
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel at end of period' }));
    expect(dialog()).toHaveTextContent('will end on 1 Feb 2026 UTC and you keep access until then');
    await click('Cancel at period end');
    expect(await screen.findByText('Cancellation scheduled. You keep access until 1 Feb 2026 UTC.')).toBeInTheDocument();
    expect(api.callsTo('POST /subscriptions/cancel')[0]!.body).toBeUndefined();
    const undo = await screen.findByRole('button', { name: 'Keep my subscription (undo cancellation)' });
    expect(undo).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Cancel at end of period' })).not.toBeInTheDocument();

    api.on('POST /subscriptions/reactivate', () => ({ body: { subscription: (state.sub = makeSub()) } }));
    await userEvent.click(undo);
    await click('Undo cancellation');
    expect(await screen.findByText(/Your cancellation was undone/)).toBeInTheDocument();
  });

  it('cancel in past_due explains that grace is kept; "cancel immediately" is a separate, explicit, danger action', async () => {
    const pastDue = makeSub({ status: 'past_due', accessAllowed: true, pastDueSince: '2026-02-01T00:00:00.000Z', graceEndsAt: '2026-02-04T00:00:00.000Z', nextRetryAt: '2026-02-02T00:00:00.000Z' });
    const { api, state } = await open('/manage', pastDue, 'Manage plan');
    api.on('POST /subscriptions/cancel', () => ({ body: { subscription: (state.sub = { ...pastDue, cancelAtPeriodEnd: true, nextRetryAt: '2026-02-04T00:00:00.000Z' }) } }));
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel at end of period' }));
    expect(dialog()).toHaveTextContent('stop trying to charge you');
    expect(dialog()).toHaveTextContent('4 Feb 2026, 00:00 UTC');
    await click('Cancel at period end');
    expect(await screen.findByText(/We will not try to charge you again, and you keep access until 4 Feb 2026, 00:00 UTC/)).toBeInTheDocument();

    api.on('POST /subscriptions/cancel', () => ({ body: { subscription: { ...pastDue, status: 'canceled' } } }));
    state.sub = pastDue;
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel immediately' }));
    expect(dialog()).toHaveTextContent('ends right now');
    expect(dialog()).toHaveTextContent('cannot be undone');
  });

  it('immediate cancellation sends { immediate: true } and returns to the dashboard', async () => {
    const pastDue = makeSub({ status: 'past_due', accessAllowed: true, pastDueSince: '2026-02-01T00:00:00.000Z', graceEndsAt: '2026-02-04T00:00:00.000Z' });
    const { api, state } = await open('/manage', pastDue, 'Manage plan');
    api.on('POST /subscriptions/cancel', () => {
      state.sub = null;
      return { body: { subscription: { ...pastDue, status: 'canceled' } } };
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel immediately' }));
    await click('Cancel immediately');
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.getByText('Your subscription has been canceled.')).toBeInTheDocument();
    expect(api.callsTo('POST /subscriptions/cancel')[0]!.body).toEqual({ immediate: true });
  });
});

describe('confirmation messages', () => {
  it('a confirmation stays on the page it belongs to and disappears once the user navigates elsewhere', async () => {
    const { api, state } = await open('/manage', makeSub(), 'Manage plan');
    api.on('POST /subscriptions/pause', () => ({ body: { subscription: (state.sub = makeSub({ status: 'paused', accessAllowed: false, pausedAt: '2026-01-10T00:00:00.000Z' })) } }));
    await userEvent.click(await screen.findByRole('button', { name: 'Pause subscription' }));
    await click('Pause subscription');
    expect(await screen.findByText('Your subscription is paused.')).toBeInTheDocument();
    await userEvent.click(within(screen.getByRole('navigation', { name: 'Primary' })).getByRole('link', { name: 'Usage' }));
    await screen.findByRole('heading', { name: 'Usage' });
    await waitFor(() => expect(screen.queryByText('Your subscription is paused.')).not.toBeInTheDocument());
  });

  it('a confirmation for an action that also navigates is shown on the destination page', async () => {
    const { api, state } = await open('/pricing', null, 'Plans');
    api.on('POST /subscriptions', () => ({ status: 201, body: { subscription: (state.sub = makeSub()) } }));
    await userEvent.click((await screen.findAllByRole('button', { name: 'Subscribe' }))[0]!);
    await click(/Pay ₹499/);
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    expect(await screen.findByText("You're subscribed to Pro.")).toBeInTheDocument();
  });
});

describe('Manage plan: the backend is the authority; its errors are displayed', () => {
  it('shows the API message when a transition is rejected (409), and keeps the dialog open', async () => {
    const { api } = await open('/manage', makeSub(), 'Manage plan');
    api.on('POST /subscriptions/pause', err(409, 'INVALID_TRANSITION', 'Cannot pause a past_due subscription', { reason: 'cannot_pause_from_past_due' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Pause subscription' }));
    await click('Pause subscription');
    expect(await within(dialog()).findByRole('alert')).toHaveTextContent('Cannot pause a past_due subscription');
  });

  it('disables actions the state does not allow, and says why', async () => {
    await open('/manage', makeSub({ status: 'paused', accessAllowed: false, pausedAt: '2026-01-10T00:00:00.000Z' }), 'Manage plan');
    expect(await screen.findByRole('button', { name: 'Upgrade to Business' })).toBeDisabled();
    expect(screen.getByText('Upgrades are only available while your subscription is active.')).toBeInTheDocument();
    const cancel = screen.getByRole('button', { name: 'Cancel at end of period' });
    expect(cancel).toBeDisabled();
    expect(cancel).toHaveAccessibleDescription('Resume your subscription before canceling it.');
    expect(screen.getByRole('button', { name: 'Resume subscription' })).toBeEnabled();
  });

  it('renewal processing: upgrade and pause are disabled with a renewal explanation; cancel is still possible', async () => {
    await open('/manage', makeSub({ accessAllowed: false }), 'Manage plan');
    expect(await screen.findByRole('button', { name: 'Upgrade to Business' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Pause subscription' })).toBeDisabled();
    expect(screen.getAllByText('Available once your renewal has been processed.').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Cancel at end of period' })).toBeEnabled();
  });

  it('without a subscription the page points to the plans', async () => {
    await open('/manage', null, 'Manage plan');
    expect(await screen.findByText('No active subscription')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Choose a plan' })).toBeInTheDocument();
  });
});
