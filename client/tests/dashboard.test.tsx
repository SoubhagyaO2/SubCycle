import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BIZ, FREE, PRO, deferred, err, makeSub, makeUsage, renderApp, signIn, signedInApi } from './mockApi';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function dashboard(sub = makeSub(), prep?: (api: ReturnType<typeof signedInApi>) => void) {
  signIn();
  const api = signedInApi(sub);
  prep?.(api);
  api.install();
  renderApp('/');
  await screen.findByRole('heading', { name: 'Dashboard' });
  return api;
}

describe('dashboard: active subscription', () => {
  it('shows plan, status, period, renewal date and live usage versus limits from the API', async () => {
    await dashboard();
    const plan = await screen.findByRole('region', { name: 'Current plan' });
    expect(within(plan).getByText('Pro')).toBeInTheDocument();
    expect(within(plan).getByText('₹499 / month')).toBeInTheDocument();
    expect(within(plan).getByText('Active')).toBeInTheDocument();
    expect(within(plan).getByText('1 Jan 2026 UTC – 1 Feb 2026 UTC')).toBeInTheDocument();
    expect(within(plan).getByText('Renews on')).toBeInTheDocument();
    expect(within(plan).getByText('Allowed')).toBeInTheDocument();

    const calls = await screen.findByRole('progressbar', { name: 'API calls used' });
    expect(calls).toHaveAttribute('aria-valuenow', '4200');
    expect(calls).toHaveAttribute('aria-valuemax', '5000');
    expect(calls).toHaveAttribute('aria-valuetext', '4200 of 5000 used');
    expect(screen.getByText('4,200 / 5,000')).toBeInTheDocument();
    expect(screen.getByText('Unlimited on your plan')).toBeInTheDocument(); // seats: limit null
    expect(screen.getByText(/Counters reset when your next billing period starts on 1 Feb 2026 UTC/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('flags an exhausted limit and a plan that does not include a metric', async () => {
    await dashboard(makeSub(), (api) =>
      api.on('GET /usage', {
        body: makeUsage({
          usage: [
            { metric: 'api_calls', used: 5000, limit: 5000, remaining: 0, unlimited: false },
            { metric: 'projects', used: 0, limit: 0, remaining: 0, unlimited: false },
          ],
        }),
      }),
    );
    expect(await screen.findByText('Limit reached')).toBeInTheDocument();
    expect(screen.getByText('Not included')).toBeInTheDocument();
  });

  it('does not infer anything from dates: a period that looks long over is still Active while the server says access is allowed', async () => {
    await dashboard(makeSub({ currentPeriodEnd: '2000-01-01T00:00:00.000Z', accessAllowed: true }));
    expect(await screen.findByText('Active')).toBeInTheDocument();
    expect(screen.queryByText(/renewal is being processed/i)).not.toBeInTheDocument();
  });
});

describe('dashboard: states that must match the backend access policy (B19)', () => {
  it('period ended, renewal not processed yet: "Renewal processing" with access paused', async () => {
    await dashboard(makeSub({ accessAllowed: false }));
    expect(await screen.findByText('Your renewal is being processed')).toBeInTheDocument();
    expect(screen.getAllByText('Renewal processing').length).toBeGreaterThan(0);
    expect(screen.getByText(/Access is paused until the renewal completes/)).toBeInTheDocument();
    expect(screen.getByText('Not allowed right now')).toBeInTheDocument();
  });

  it('follows the server: processing -> renewed (polls without any user action)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = await dashboard(makeSub({ accessAllowed: false }));
    expect(await screen.findByText('Your renewal is being processed')).toBeInTheDocument();
    api.on('GET /subscriptions/current', { body: { subscription: makeSub({ currentPeriodStart: '2026-02-01T00:00:00.000Z', currentPeriodEnd: '2026-03-01T00:00:00.000Z' }) } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5100);
    });
    expect(await screen.findByText('1 Feb 2026 UTC – 1 Mar 2026 UTC')).toBeInTheDocument();
    expect(screen.queryByText('Your renewal is being processed')).not.toBeInTheDocument();
    const polls = api.callsTo('GET /subscriptions/current').length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(api.callsTo('GET /subscriptions/current').length).toBe(polls); // stops polling once the server says it is settled
  });

  it('follows the server: processing -> past_due grace after a failed renewal (access comes back as GRACE, not as a date guess)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = await dashboard(makeSub({ accessAllowed: false }));
    expect(await screen.findByText('Your renewal is being processed')).toBeInTheDocument();
    api.on('GET /subscriptions/current', {
      body: {
        subscription: makeSub({
          status: 'past_due',
          accessAllowed: true,
          pastDueSince: '2026-02-01T00:10:00.000Z',
          graceEndsAt: '2026-02-04T00:10:00.000Z',
          nextRetryAt: '2026-02-02T00:10:00.000Z',
          retryCount: 0,
        }),
      },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5100);
    });
    expect(await screen.findByText('Your last payment failed')).toBeInTheDocument();
    expect(screen.getByText(/You keep access until 4 Feb 2026, 00:10 UTC/)).toBeInTheDocument();
    expect(screen.getByText(/We will try again on 2 Feb 2026, 00:10 UTC/)).toBeInTheDocument();
    expect(screen.getByText('Payment failed (grace period)')).toBeInTheDocument();
    expect(screen.getByText('Grace period ends')).toBeInTheDocument();
    expect(screen.getByText('Allowed')).toBeInTheDocument();
    expect(screen.queryByText('Your renewal is being processed')).not.toBeInTheDocument();
  });

  it('past_due within grace: explains the grace period and the next retry', async () => {
    await dashboard(makeSub({ status: 'past_due', accessAllowed: true, pastDueSince: '2026-02-01T00:00:00.000Z', graceEndsAt: '2026-02-04T00:00:00.000Z', nextRetryAt: '2026-02-02T00:00:00.000Z' }));
    expect(await screen.findByText('Your last payment failed')).toBeInTheDocument();
    expect(screen.getByText(/keep access until 4 Feb 2026, 00:00 UTC/)).toBeInTheDocument();
    expect(screen.getByText(/If payment keeps failing your subscription will be canceled/)).toBeInTheDocument();
  });

  it('past_due with a user-requested cancellation: no more attempts, ends at the grace end', async () => {
    await dashboard(makeSub({ status: 'past_due', accessAllowed: true, cancelAtPeriodEnd: true, graceEndsAt: '2026-02-04T00:00:00.000Z', pastDueSince: '2026-02-01T00:00:00.000Z' }));
    expect(await screen.findByText(/we will not try to charge you again/i)).toBeInTheDocument();
    expect(screen.getByText(/until 4 Feb 2026, 00:00 UTC, when your subscription ends/)).toBeInTheDocument();
    expect(screen.queryByText(/We will try again/)).not.toBeInTheDocument();
  });

  it('grace expired: access blocked, final attempt pending', async () => {
    await dashboard(makeSub({ status: 'past_due', accessAllowed: false, graceEndsAt: '2026-02-04T00:00:00.000Z', pastDueSince: '2026-02-01T00:00:00.000Z' }));
    expect(await screen.findByText('Access is blocked: payment is overdue')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('final payment attempt is pending');
    expect(screen.getByText('Past due (access blocked)')).toBeInTheDocument();
  });

  it('paused: explains that usage and renewals are stopped', async () => {
    await dashboard(makeSub({ status: 'paused', accessAllowed: false, pausedAt: '2026-01-10T00:00:00.000Z' }));
    expect(await screen.findByText('Your subscription is paused')).toBeInTheDocument();
    expect(screen.getByText('Paused')).toBeInTheDocument();
    expect(screen.getByText('Period ends (extended on resume)')).toBeInTheDocument();
  });

  it('scheduled cancellation: shows when it ends and that a scheduled plan change will not apply', async () => {
    await dashboard(makeSub({ cancelAtPeriodEnd: true, pendingPlan: FREE }));
    expect(await screen.findByText('Cancellation scheduled')).toBeInTheDocument();
    expect(screen.getByText(/will end on 1 Feb 2026 UTC/)).toBeInTheDocument();
    expect(screen.getByText('Ends on')).toBeInTheDocument();
    expect(screen.queryByText(/Scheduled change to/)).not.toBeInTheDocument(); // cancellation wins; not both
  });

  it('scheduled downgrade: names the plan and the date, and says current limits stay until then', async () => {
    await dashboard(makeSub({ plan: BIZ, pendingPlan: PRO }));
    expect(await screen.findByText('Scheduled change to Pro')).toBeInTheDocument();
    expect(screen.getByText(/keep Business and its limits until 1 Feb 2026 UTC, then move to Pro/)).toBeInTheDocument();
  });
});

describe('dashboard: loading, empty and error states', () => {
  it('shows a loading state while the subscription loads', async () => {
    const gate = deferred();
    signIn();
    const api = signedInApi();
    api.on('GET /subscriptions/current', { body: { subscription: makeSub() }, gate: gate.promise });
    api.install();
    renderApp('/');
    expect(await screen.findByText(/Loading your subscription/)).toBeInTheDocument();
    gate.resolve();
    expect(await screen.findByRole('region', { name: 'Current plan' })).toBeInTheDocument();
  });

  it('no subscription: an empty state with a link to the plans', async () => {
    signIn();
    signedInApi(null).install();
    renderApp('/');
    expect(await screen.findByText("You don't have a subscription yet")).toBeInTheDocument();
    await userEvent.click(screen.getByRole('link', { name: 'Choose a plan' }));
    expect(await screen.findByRole('heading', { name: 'Plans' })).toBeInTheDocument();
  });

  it('a server error shows the API message with a working retry', async () => {
    signIn();
    const api = signedInApi();
    api.on('GET /subscriptions/current', err(500, 'INTERNAL_ERROR', 'An unexpected error occurred'));
    api.install();
    renderApp('/');
    expect(await screen.findByText('Could not load your subscription')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('An unexpected error occurred');
    api.on('GET /subscriptions/current', { body: { subscription: makeSub() } });
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('region', { name: 'Current plan' })).toBeInTheDocument();
  });

  it('a usage failure does not hide the subscription; the usage card has its own error and retry', async () => {
    await dashboard(makeSub(), (api) => api.on('GET /usage', err(500, 'INTERNAL_ERROR', 'An unexpected error occurred')));
    expect(await screen.findByRole('region', { name: 'Current plan' })).toBeInTheDocument();
    expect(await screen.findByText('Could not load usage')).toBeInTheDocument();
  });

  it('a network failure is reported as such, not as a crash', async () => {
    signIn();
    const api = signedInApi();
    api.on('GET /subscriptions/current', { networkError: true });
    api.install();
    renderApp('/');
    expect(await screen.findByText(/Cannot reach the server/)).toBeInTheDocument();
  });
});

describe('every screen uses the API (nothing hardcoded)', () => {
  it('plan, price and usage numbers come from the mocked responses: change them and the screen changes', async () => {
    await dashboard(makeSub({ plan: { ...PRO, name: 'Zeta', priceCents: 12_345 } }), (api) =>
      api.on('GET /usage', { body: makeUsage({ usage: [{ metric: 'api_calls', used: 7, limit: 9, remaining: 2, unlimited: false }] }) }),
    );
    expect(await screen.findByText('Zeta')).toBeInTheDocument();
    expect(screen.getByText('₹123.45 / month')).toBeInTheDocument();
    expect(await screen.findByText('7 / 9')).toBeInTheDocument();
    expect(screen.queryByText('Pro')).not.toBeInTheDocument();
  });
});
