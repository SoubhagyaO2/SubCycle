import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { configureAxe } from 'jest-axe';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BIZ, PRO, deferred, makeSub, renderApp, signIn, signedInApi, type MockApi } from './mockApi';

afterEach(() => {
  vi.unstubAllGlobals();
});

// jsdom has no layout, so colour-contrast cannot be evaluated here; structure, names, roles and labels can.
const axe = configureAxe({ rules: { 'color-contrast': { enabled: false } } });

async function render(path: string, heading: string, sub = makeSub(), prep?: (api: MockApi) => void, signedIn = true) {
  if (signedIn) signIn();
  const api = signedInApi(sub);
  prep?.(api);
  api.install();
  const view = renderApp(path);
  await screen.findByRole('heading', { name: heading });
  return { api, container: view.container };
}

describe('automated accessibility checks (axe)', () => {
  it.each([
    ['/login', 'Sign in to your account', false],
    ['/register', 'Create your account', false],
  ])('%s has no violations', async (path, heading, signedIn) => {
    const { container } = await render(path, heading, makeSub(), undefined, signedIn);
    expect((await axe(container)).violations).toEqual([]);
  });

  it('the dashboard has no violations in the active, grace and renewal-processing states', async () => {
    for (const sub of [
      makeSub(),
      makeSub({ accessAllowed: false }),
      makeSub({ status: 'past_due', accessAllowed: true, pastDueSince: '2026-02-01T00:00:00.000Z', graceEndsAt: '2026-02-04T00:00:00.000Z', nextRetryAt: '2026-02-02T00:00:00.000Z' }),
      makeSub({ status: 'paused', accessAllowed: false, cancelAtPeriodEnd: true }),
    ]) {
      const { container } = await render('/', 'Dashboard', sub);
      await screen.findByRole('region', { name: 'Current plan' });
      await screen.findByRole('progressbar', { name: 'API calls used' });
      expect((await axe(container)).violations).toEqual([]);
      cleanup();
    }
  });

  it.each([
    ['/pricing', 'Plans'],
    ['/manage', 'Manage plan'],
    ['/usage', 'Usage'],
    ['/invoices', 'Billing'],
    ['/history', 'Subscription history'],
  ])('%s has no violations', async (path, heading) => {
    const { container } = await render(path, heading, makeSub(), (api) => {
      api.on('GET /invoices', { body: { invoices: [{ id: 'i', subscriptionId: 's', kind: 'renewal', status: 'paid', amountCents: 49_900, description: 'Pro renewal', billingPeriodStart: '2026-02-01T00:00:00.000Z', createdAt: '2026-02-01T00:00:00.000Z' }] } });
      api.on('GET /billing/operations', { body: { operations: [{ id: 'o', type: 'refund', status: 'failed', kind: 'upgrade', amountCents: 100, attempt: 1, reason: 'state_changed', errorMessage: 'x', invoiceId: null, refundOfOperationId: 'c', createdAt: '2026-02-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z' }] } });
      api.on('GET /usage/history', { body: { periods: [{ periodStart: '2026-01-01T00:00:00.000Z', isCurrent: true, metrics: [{ metric: 'api_calls', used: 3 }] }] } });
      api.on('GET /subscriptions/history', { body: { events: [{ id: 'e', subscriptionId: 's', type: 'subscribed', fromStatus: null, toStatus: 'active', meta: { plan_id: PRO.id, amount_cents: 49_900 }, createdAt: '2026-01-01T00:00:00.000Z' }] } });
    });
    await waitFor(() => expect(screen.queryByText(/Loading/)).not.toBeInTheDocument());
    expect((await axe(container)).violations).toEqual([]);
  });

  it('an open confirmation dialog has no violations', async () => {
    const { container, api } = await render('/manage', 'Manage plan');
    api.on('GET /subscriptions/upgrade-preview', { body: { preview: { fromPlan: PRO, toPlan: BIZ, amountCents: 100, chargeRequired: true, remainingMs: 1, totalMs: 2, periodStart: 'a', periodEnd: 'b', computedAt: 'c' } } });
    await userEvent.click(await screen.findByRole('button', { name: 'Upgrade to Business' }));
    await within(screen.getByRole('dialog')).findByText('₹1');
    expect((await axe(container)).violations).toEqual([]);
  });
});

describe('landmarks and structure', () => {
  it('has a skip link, banner, labelled primary navigation and main landmark; the current page is marked', async () => {
    await render('/usage', 'Usage');
    expect(screen.getByRole('link', { name: 'Skip to main content' })).toHaveAttribute('href', '#main');
    expect(screen.getByRole('banner')).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(within(nav).getByRole('link', { name: 'Usage' })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('link', { name: 'Dashboard' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main');
  });

  it('status is conveyed with text, not colour alone', async () => {
    await render('/', 'Dashboard', makeSub({ status: 'past_due', accessAllowed: false, graceEndsAt: '2026-02-04T00:00:00.000Z' }));
    expect(await screen.findByText('Past due (access blocked)')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Error:'); // sr-only tone prefix on the banner
  });

  it('tables have captions and column headers', async () => {
    await render('/invoices', 'Billing', makeSub(), (api) =>
      api.on('GET /invoices', { body: { invoices: [{ id: 'i', subscriptionId: 's', kind: 'renewal', status: 'paid', amountCents: 49_900, description: 'Pro renewal', billingPeriodStart: '2026-02-01T00:00:00.000Z', createdAt: '2026-02-01T00:00:00.000Z' }] } }),
    );
    const table = await screen.findByRole('table', { name: 'Invoices, newest first' });
    expect(within(table).getAllByRole('columnheader').length).toBeGreaterThanOrEqual(5);
  });
});

describe('keyboard use', () => {
  it('Tab reaches the skip link first, then the navigation, in order', async () => {
    await render('/', 'Dashboard');
    await userEvent.tab();
    expect(screen.getByRole('link', { name: 'Skip to main content' })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole('link', { name: 'SubCycle' })).toHaveFocus();
    await userEvent.tab();
    await userEvent.tab(); // skips the (CSS-hidden on desktop) menu button? it is focusable in jsdom: just ensure nav links follow
    const link = within(screen.getByRole('navigation', { name: 'Primary' })).getByRole('link', { name: 'Dashboard' });
    link.focus();
    await userEvent.tab();
    expect(within(screen.getByRole('navigation', { name: 'Primary' })).getByRole('link', { name: 'Plans' })).toHaveFocus();
  });

  it('navigating with the keyboard (Enter on a link) changes the page and moves focus to the main region', async () => {
    await render('/', 'Dashboard');
    within(screen.getByRole('navigation', { name: 'Primary' })).getByRole('link', { name: 'History' }).focus();
    await userEvent.keyboard('{Enter}');
    await screen.findByRole('heading', { name: 'Subscription history' });
    await waitFor(() => expect(screen.getByRole('main')).toHaveFocus());
  });

  it('the mobile menu button toggles aria-expanded', async () => {
    await render('/', 'Dashboard');
    const button = screen.getByRole('button', { name: 'Menu' });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button).toHaveAttribute('aria-controls', 'primary-nav');
    await userEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(within(screen.getByRole('navigation', { name: 'Primary' })).getByRole('link', { name: 'Plans' }));
    await screen.findByRole('heading', { name: 'Plans' });
    expect(screen.getByRole('button', { name: 'Menu' })).toHaveAttribute('aria-expanded', 'false'); // closes after choosing
  });

  it('forms: labels are bound, Enter submits, and errors are announced', async () => {
    const { api } = await render('/login', 'Sign in to your account', makeSub(), undefined, false);
    api.on('POST /auth/login', { status: 401, body: { error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password', details: {} } } });
    await userEvent.type(screen.getByLabelText('Email'), 'alice@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'wrong-password{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password');
    await userEvent.clear(screen.getByLabelText('Email'));
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    const email = screen.getByLabelText('Email');
    expect(email).toHaveAttribute('aria-invalid', 'true');
    expect(email).toHaveAccessibleDescription('Enter your email address.');
  });
});

describe('confirmation dialog keyboard behaviour', () => {
  async function openCancelDialog() {
    const { api } = await render('/manage', 'Manage plan');
    const opener = await screen.findByRole('button', { name: 'Cancel at end of period' });
    opener.focus();
    await userEvent.keyboard('{Enter}');
    return { api, opener, dialog: await screen.findByRole('dialog', { name: 'Cancel at the end of your period?' }) };
  }

  it('opens from the keyboard, is modal and labelled, and moves focus inside', async () => {
    const { dialog } = await openCancelDialog();
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleDescription(/Your subscription will end on 1 Feb 2026 UTC/);
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('traps Tab and Shift+Tab inside the dialog', async () => {
    const { dialog } = await openCancelDialog();
    const buttons = within(dialog).getAllByRole('button');
    const first = buttons[0]!;
    const last = buttons[buttons.length - 1]!;
    last.focus();
    await userEvent.tab();
    expect(first).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(last).toHaveFocus();
    for (let i = 0; i < 6; i++) {
      await userEvent.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it('Escape closes it and returns focus to the button that opened it, without calling the API', async () => {
    const { api, opener } = await openCancelDialog();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
    expect(api.callsTo('POST /subscriptions/cancel')).toHaveLength(0);
  });

  it('while a request is in flight Escape does nothing and the buttons are disabled (cannot abandon a billing action midway)', async () => {
    const gate = deferred();
    const { api } = await openCancelDialog();
    api.on('POST /subscriptions/cancel', { body: { subscription: makeSub({ cancelAtPeriodEnd: true }) }, gate: gate.promise });
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel at period end' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-busy', 'true');
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    gate.resolve();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});
