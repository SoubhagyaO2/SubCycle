import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BillingOperation, HistoryEvent, Invoice } from '../src/api/types';
import { PRO, deferred, err, makeSub, makeUsage, renderApp, signIn, signedInApi, type MockApi } from './mockApi';

afterEach(() => {
  vi.unstubAllGlobals();
});

async function page(path: string, heading: string, prep?: (api: MockApi) => void, sub = makeSub()) {
  signIn();
  const api = signedInApi(sub);
  prep?.(api);
  api.install();
  renderApp(path);
  await screen.findByRole('heading', { name: heading });
  return api;
}

const inv = (o: Partial<Invoice>): Invoice => ({ id: 'i1', subscriptionId: 's', kind: 'renewal', status: 'paid', amountCents: 49_900, description: 'Pro renewal', billingPeriodStart: '2026-02-01T00:00:00.000Z', createdAt: '2026-02-01T00:00:05.000Z', ...o });
const op = (o: Partial<BillingOperation>): BillingOperation => ({
  id: 'op1', type: 'charge', status: 'succeeded', kind: 'renewal', amountCents: 49_900, attempt: 1, reason: null, errorMessage: null, invoiceId: null, refundOfOperationId: null, createdAt: '2026-02-01T00:00:05.000Z', updatedAt: '2026-02-01T00:00:05.000Z', ...o,
});

describe('Billing: invoices', () => {
  it('shows paid, failed and refunded invoices with distinct labels, amounts and periods', async () => {
    await page('/invoices', 'Billing', (api) =>
      api.on('GET /invoices', {
        body: {
          invoices: [
            inv({ id: 'a', status: 'paid', kind: 'renewal' }),
            inv({ id: 'b', status: 'failed', kind: 'upgrade_proration', amountCents: 33_803, description: 'Upgrade from Free to Pro (prorated)' }),
            inv({ id: 'c', status: 'refunded', kind: 'initial', amountCents: 49_900, description: 'Pro subscription' }),
          ],
        },
      }),
    );
    const table = await screen.findByRole('table', { name: 'Invoices, newest first' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByText('Paid')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Payment failed')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('₹338.03')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Upgrade (prorated)')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('Refunded')).toBeInTheDocument();
    expect(within(rows[0]!).getAllByText('1 Feb 2026 UTC', { selector: 'td' })).toHaveLength(2); // invoice date and period start
  });

  it('empty and error states', async () => {
    await page('/invoices', 'Billing');
    expect(await screen.findByText('No invoices yet')).toBeInTheDocument();
    expect(await screen.findByText('No payment attempts yet')).toBeInTheDocument();
  });

  it('an invoices failure shows an error with retry and does not break the page', async () => {
    const api = await page('/invoices', 'Billing', (a) => a.on('GET /invoices', err(500, 'INTERNAL_ERROR', 'An unexpected error occurred')));
    expect(await screen.findByText('Could not load invoices')).toBeInTheDocument();
    api.on('GET /invoices', { body: { invoices: [inv({})] } });
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('table', { name: 'Invoices, newest first' })).toBeInTheDocument();
  });
});

describe('Billing: policies are stated explicitly', () => {
  it('says that missed renewal periods are charged (not forgiven) and that month-end billing dates can drift', async () => {
    await page('/invoices', 'Billing');
    const notes = await screen.findByRole('region', { name: 'How billing works' });
    expect(notes).toHaveTextContent('missed periods are not forgiven');
    expect(notes).toHaveTextContent('Billing dates can drift at the end of a month');
    expect(notes).toHaveTextContent('31 Jan → 28 Feb → 28 Mar');
    expect(notes).toHaveTextContent('72 hours');
    expect(notes).toHaveTextContent('access stops at that moment');
  });
});

describe('Billing: payment attempts and refunds (pending, failed, paid, refunded are distinct)', () => {
  it('a PENDING payment is shown as in progress, never as paid, with an explanatory banner', async () => {
    await page('/invoices', 'Billing', (api) => api.on('GET /billing/operations', { body: { operations: [op({ status: 'pending', kind: 'upgrade' })] } }));
    const table = await screen.findByRole('table', { name: /Payment attempts and refunds/ });
    const row = within(table).getAllByRole('row')[1]!;
    expect(within(row).getByText('In progress')).toBeInTheDocument();
    expect(within(row).queryByText('Succeeded')).not.toBeInTheDocument();
    expect(within(row).getByText(/not counted as paid until it is confirmed/)).toBeInTheDocument();
    expect(await screen.findByText('A payment is still being confirmed')).toBeInTheDocument();
  });

  it('a FAILED REFUND is flagged prominently with a reference, and is not shown as refunded', async () => {
    await page('/invoices', 'Billing', (api) =>
      api.on('GET /billing/operations', {
        body: {
          operations: [
            op({ id: 'refund-77', type: 'refund', status: 'failed', kind: 'upgrade', reason: 'state_changed', errorMessage: 'refund_not_allowed: The provider refuses this refund', refundOfOperationId: 'op1' }),
            op({ id: 'op1', status: 'succeeded', kind: 'upgrade', amountCents: 33_803 }),
          ],
        },
      }),
    );
    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent('A refund could not be completed');
    expect(banner).toHaveTextContent('It has not been refunded');
    const table = screen.getByRole('table', { name: /Payment attempts and refunds/ });
    const failedRow = within(table).getAllByRole('row')[1]!;
    expect(within(failedRow).getByText('Refund failed')).toBeInTheDocument();
    expect(within(failedRow).getByText(/needs attention/)).toBeInTheDocument();
    expect(within(failedRow).getByText(/refund-77/)).toBeInTheDocument();
    expect(within(failedRow).queryByText('Refunded')).not.toBeInTheDocument();
    expect(within(failedRow).getByText('Refund of upgrade payment')).toBeInTheDocument();
  });

  it('pending refund, succeeded refund and failed charge (with the provider message and attempt number)', async () => {
    await page('/invoices', 'Billing', (api) =>
      api.on('GET /billing/operations', {
        body: {
          operations: [
            op({ id: 'r1', type: 'refund', status: 'pending', refundOfOperationId: 'x' }),
            op({ id: 'r2', type: 'refund', status: 'succeeded', refundOfOperationId: 'y' }),
            op({ id: 'c2', status: 'failed', attempt: 2, errorMessage: 'card_declined: The payment was declined' }),
            op({ id: 'c3', status: 'succeeded', attempt: 3 }),
          ],
        },
      }),
    );
    const table = await screen.findByRole('table', { name: /Payment attempts and refunds/ });
    expect(within(table).getByText('Refund pending')).toBeInTheDocument();
    expect(within(table).getByText('Refunded')).toBeInTheDocument();
    expect(within(table).getByText('Failed')).toBeInTheDocument();
    expect(within(table).getByText('card_declined: The payment was declined')).toBeInTheDocument();
    expect(within(table).getByText('Attempt 2')).toBeInTheDocument();
    expect(within(table).getByText('Succeeded')).toBeInTheDocument();
    expect(await screen.findByText('A refund is on its way')).toBeInTheDocument();
  });
});

describe('Usage page', () => {
  it('shows current usage with progress bars, the period, and usage history with the current period marked', async () => {
    await page('/usage', 'Usage', (api) =>
      api.on('GET /usage/history', {
        body: {
          periods: [
            { periodStart: '2026-01-01T00:00:00.000Z', isCurrent: true, metrics: [{ metric: 'api_calls', used: 4200 }, { metric: 'projects', used: 2 }] },
            { periodStart: '2025-12-01T00:00:00.000Z', isCurrent: false, metrics: [{ metric: 'api_calls', used: 900 }] },
          ],
        },
      }),
    );
    expect(await screen.findByRole('progressbar', { name: 'API calls used' })).toHaveAttribute('aria-valuenow', '4200');
    expect(screen.getByText(/1 Jan 2026 UTC – 1 Feb 2026 UTC/)).toBeInTheDocument();
    const table = await screen.findByRole('table', { name: /Usage per billing period/ });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(within(rows[0]!).getByText('Current')).toBeInTheDocument();
    expect(within(rows[0]!).getByText(/API calls: 4,200 · Projects: 2/)).toBeInTheDocument();
    expect(within(rows[1]!).getByText(/API calls: 900/)).toBeInTheDocument();
    expect(within(rows[1]!).queryByText('Current')).not.toBeInTheDocument();
  });

  it('tells the user when the server is not allowing usage, using the server\'s status', async () => {
    await page('/usage', 'Usage', (api) => api.on('GET /usage', { body: makeUsage({ subscription: { id: 's', status: 'past_due', accessAllowed: false, graceEndsAt: null } }) }));
    expect(await screen.findByText('Usage is currently not allowed')).toBeInTheDocument();
    expect(screen.getByText(/status: past due/)).toBeInTheDocument();
  });

  it('empty history and no-subscription states', async () => {
    await page('/usage', 'Usage');
    expect(await screen.findByText('No usage recorded yet')).toBeInTheDocument();
  });

  it('no subscription: an empty state instead of bars', async () => {
    signIn();
    signedInApi(null).install();
    renderApp('/usage');
    expect(await screen.findByText('No subscription')).toBeInTheDocument();
  });
});

describe('Demo report generation (server-side enforcement)', () => {
  it('generates a report via the API, lists it, and refreshes the usage numbers from the server', async () => {
    let used = 4200;
    const api = await page('/usage', 'Usage', (a) => {
      a.on('GET /usage', () => ({ body: makeUsage({ usage: [{ metric: 'api_calls', used, limit: 5000, remaining: 5000 - used, unlimited: false }] }) }));
      a.on('POST /demo/generate-report', () => {
        used += 1;
        return { status: 201, body: { report: { id: 'r1', title: `Demo report #${used}`, generatedAt: '2026-01-10T10:00:00.000Z' }, usage: { metric: 'api_calls', used, limit: 5000, remaining: 5000 - used, unlimited: false } } };
      });
    });
    expect(await screen.findByText('4,200 / 5,000')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Generate report' }));
    expect(await screen.findByText('Demo report #4201')).toBeInTheDocument();
    expect(await screen.findByText('4,201 / 5,000')).toBeInTheDocument();
    expect(api.callsTo('POST /demo/generate-report')).toHaveLength(1);
    expect(api.callsTo('POST /demo/generate-report')[0]!.headers.authorization).toBe('Bearer test-token');
  });

  it('when the server says the limit is reached, no report is shown and the limit details are explained', async () => {
    await page('/usage', 'Usage', (a) =>
      a.on('POST /demo/generate-report', err(429, 'LIMIT_EXCEEDED', 'Limit reached for "api_calls"', { metric: 'api_calls', limit: 100, used: 100, remaining: 0, requested: 1, periodEnd: '2026-02-01T00:00:00.000Z' })),
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Generate report' }));
    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent('Limit reached: no report was generated');
    expect(banner).toHaveTextContent('used 100 of 100 API calls');
    expect(banner).toHaveTextContent('resets on 1 Feb 2026 UTC');
    expect(screen.queryByText('Generated in this session')).not.toBeInTheDocument();
  });

  it('shows the server message for an inactive subscription (402)', async () => {
    await page('/usage', 'Usage', (a) => a.on('POST /demo/generate-report', err(402, 'SUBSCRIPTION_INACTIVE', 'Your billing period has ended and renewal is being processed; usage is not allowed until it completes', { status: 'active', reason: 'period_ended' })));
    await userEvent.click(await screen.findByRole('button', { name: 'Generate report' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('renewal is being processed');
  });

  it('a network failure says the result is unknown instead of guessing', async () => {
    await page('/usage', 'Usage', (a) => a.on('POST /demo/generate-report', { networkError: true }));
    await userEvent.click(await screen.findByRole('button', { name: 'Generate report' }));
    const banner = await screen.findByRole('status');
    expect(banner).toHaveTextContent('We could not confirm the result');
    expect(banner).toHaveTextContent('may or may not have been counted');
  });

  it('a double click produces one request (single flight) and the button shows it is busy', async () => {
    const gate = deferred();
    const api = await page('/usage', 'Usage', (a) =>
      a.on('POST /demo/generate-report', { status: 201, gate: gate.promise, body: { report: { id: 'r1', title: 'Demo report #1', generatedAt: '2026-01-10T10:00:00.000Z' }, usage: { metric: 'api_calls', used: 1, limit: 100, remaining: 99, unlimited: false } } }),
    );
    const button = await screen.findByRole('button', { name: 'Generate report' });
    await userEvent.dblClick(button);
    await userEvent.click(button);
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    gate.resolve();
    expect(await screen.findByText('Demo report #1')).toBeInTheDocument();
    expect(api.callsTo('POST /demo/generate-report')).toHaveLength(1);
    await waitFor(() => expect(button).toBeEnabled());
  });
});

describe('History page', () => {
  const ev = (id: string, type: string, createdAt: string, meta: Record<string, unknown> = {}, from: HistoryEvent['fromStatus'] = null, to: HistoryEvent['toStatus'] = null): HistoryEvent => ({ id, subscriptionId: 's', type, fromStatus: from, toStatus: to, meta, createdAt });

  it('shows the timeline newest first with meaningful wording, including failed and recovered renewals', async () => {
    await page('/history', 'Subscription history', (api) =>
      api.on('GET /subscriptions/history', {
        body: {
          events: [
            ev('1', 'subscribed', '2026-01-01T00:00:00.000Z', { plan_id: PRO.id, amount_cents: 49_900 }, null, 'active'),
            ev('2', 'renewal_failed', '2026-02-01T00:10:00.000Z', { grace_ends_at: '2026-02-04T00:10:00.000Z', next_retry_at: '2026-02-02T00:10:00.000Z' }, 'active', 'past_due'),
            ev('3', 'renewed', '2026-02-02T00:10:00.000Z', { amount_cents: 49_900, period_end: '2026-03-01T00:00:00.000Z', recovered_from_past_due: true }, 'past_due', 'active'),
            ev('4', 'charge_discarded', '2026-02-03T00:00:00.000Z', { amount_cents: 33_803 }),
          ],
        },
      }),
    );
    const list = await screen.findByRole('list', { name: /newest first/ });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(4);
    expect(items[0]).toHaveTextContent('Payment refunded');
    expect(items[1]).toHaveTextContent('Subscription renewed');
    expect(items[1]).toHaveTextContent('Recovered after a failed payment');
    expect(items[1]).toHaveTextContent('past due → active');
    expect(items[2]).toHaveTextContent('Renewal payment failed');
    expect(items[2]).toHaveTextContent('Access continues until 4 Feb 2026, 00:10 UTC');
    expect(items[3]).toHaveTextContent('Subscribed to Pro');
    expect(items[3]).toHaveTextContent('Charged ₹499');
  });

  it('empty and error states', async () => {
    const api = await page('/history', 'Subscription history');
    expect(await screen.findByText('Nothing here yet')).toBeInTheDocument();
    api.on('GET /subscriptions/history', err(500, 'INTERNAL_ERROR', 'An unexpected error occurred'));
    await userEvent.click(screen.getByRole('link', { name: 'Billing' }));
    await screen.findByRole('heading', { name: 'Billing' });
    await userEvent.click(screen.getByRole('link', { name: 'History' }));
    expect(await screen.findByText('Could not load history')).toBeInTheDocument();
  });
});
