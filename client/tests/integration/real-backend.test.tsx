/**
 * The REAL stack: the UI (rendered in jsdom) talks over HTTP to the REAL Express server (spawned here, fake clock,
 * jobs off, dev endpoints on) backed by the REAL PostgreSQL test database. Nothing is mocked. This is what proves that
 * the screens use the actual API and agree with the backend's policies (B19).
 *
 * Prerequisite: PostgreSQL from docker compose (`npm run db:up`). The test database is reset when this file starts,
 * so do not run it at the same time as the server tests (root `npm test` runs them one after the other).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Pool } from 'pg';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import App from '../../src/App';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const serverDir = path.join(repo, 'server');
const tsx = path.join(repo, 'node_modules/tsx/dist/cli.mjs');
const PORT = 4791;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://subcycle:subcycle_local_pw@localhost:5433/subcycle_test';
const PASSWORD = 'correct horse battery';
const LONG = 60_000;

let server: ChildProcess;
let serverLog = '';
let pool: Pool;
let counter = 0;

beforeAll(async () => {
  if (!new URL(DB_URL).pathname.endsWith('_test')) throw new Error('refusing to reset a database that is not a *_test database');
  const env = { ...process.env, DATABASE_URL: DB_URL, NODE_ENV: 'test' };
  const reset = spawnSync(process.execPath, [tsx, 'scripts/reset.ts'], { cwd: serverDir, env, encoding: 'utf8' });
  if (reset.status !== 0) throw new Error(`db reset failed (is PostgreSQL up? npm run db:up): ${reset.stderr || reset.stdout}`);

  server = spawn(process.execPath, [tsx, 'src/server.ts'], {
    cwd: serverDir,
    env: {
      ...env,
      PORT: String(PORT),
      FAKE_CLOCK: 'true',
      RUN_JOBS: 'false',
      ENABLE_DEV_ENDPOINTS: 'true',
      JWT_EXPIRES_IN_SECONDS: '86400',
      AUTH_RATE_LIMIT_MAX: '100000',
      USAGE_RATE_LIMIT_MAX: '100000',
      MOCK_BILLING_FAIL: 'never',
    },
  });
  server.stdout?.on('data', (d: Buffer) => (serverLog += d.toString()));
  server.stderr?.on('data', (d: Buffer) => (serverLog += d.toString()));

  const deadline = Date.now() + 40_000;
  for (;;) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`backend did not start:\n${serverLog}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  pool = new Pool({ connectionString: DB_URL, max: 3 });
}, 90_000);

afterAll(async () => {
  server?.kill();
  await pool?.end();
});

const mount = (p = '/') =>
  render(
    <MemoryRouter initialEntries={[p]}>
      <App apiBaseUrl={BASE} />
    </MemoryRouter>,
  );

const newEmail = () => `user${Date.now()}-${++counter}@example.com`;
const token = () => (JSON.parse(window.localStorage.getItem('subcycle.session') ?? '{}') as { token?: string }).token ?? '';
const dev = async (p: string, body: unknown = {}) => {
  const res = await fetch(`${BASE}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` }, body: JSON.stringify(body) });
  return (await res.json()) as Record<string, unknown>;
};
const fakeNow = async () => new Date(((await (await fetch(`${BASE}/health`)).json()) as { time: string }).time);
const userId = async (email: string) => (await pool.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [email])).rows[0]!.id;
const nav = (name: string) => userEvent.click(within(screen.getByRole('navigation', { name: 'Primary' })).getByRole('link', { name }));
const slow = { timeout: 15_000 };
/** Retry-safe "this text is on screen" (the element found by findBy can be replaced by a re-render between steps). */
const see = (text: string | RegExp) => waitFor(() => expect(screen.getAllByText(text).length).toBeGreaterThan(0), slow);

async function register(email = newEmail()) {
  const view = mount('/register');
  await userEvent.type(screen.getByLabelText('Name'), 'Test User');
  await userEvent.type(screen.getByLabelText('Email'), email);
  await userEvent.type(screen.getByLabelText('Password'), PASSWORD);
  await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
  await screen.findByRole('heading', { name: 'Dashboard' }, slow);
  return { email, view };
}

async function subscribeFree() {
  await nav('Plans');
  await userEvent.click(await screen.findByRole('button', { name: 'Start for free' }, slow));
  await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Start for free' }));
  await screen.findByText("You're subscribed to Free.", undefined, slow);
}

async function subscribePro() {
  await nav('Plans');
  const pro = await screen.findByRole('article', { name: 'Pro' }, slow);
  await userEvent.click(within(pro).getByRole('button', { name: 'Subscribe' }));
  await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Pay ₹499 and subscribe/ }));
  await screen.findByText("You're subscribed to Pro.", undefined, slow);
}

describe('real backend: authentication', () => {
  it('registers, persists the session across a reload, signs out and signs back in', async () => {
    const { email, view } = await register();
    expect(await screen.findByText(/don't have a subscription yet/i, undefined, slow)).toBeInTheDocument(); // real 404 handled

    view.unmount();
    mount('/'); // "page reload": the stored token is validated by the real /auth/me
    expect(await screen.findByRole('heading', { name: 'Dashboard' }, slow)).toBeInTheDocument();
    expect(screen.getByText(email)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await screen.findByRole('heading', { name: 'Sign in to your account' });
    await userEvent.type(screen.getByLabelText('Email'), email);
    await userEvent.type(screen.getByLabelText('Password'), 'definitely wrong');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert', undefined, slow)).toHaveTextContent('Invalid email or password');
    await userEvent.clear(screen.getByLabelText('Password'));
    await userEvent.type(screen.getByLabelText('Password'), PASSWORD);
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByRole('heading', { name: 'Dashboard' }, slow);
  }, LONG);

  it('shows the real server error for a duplicate email', async () => {
    const { email, view } = await register();
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    view.unmount();
    mount('/register');
    await userEvent.type(screen.getByLabelText('Name'), 'Again');
    await userEvent.type(screen.getByLabelText('Email'), email);
    await userEvent.type(screen.getByLabelText('Password'), PASSWORD);
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByRole('alert', undefined, slow)).toHaveTextContent('An account with this email already exists');
  }, LONG);

  it('an expired token (the server clock moves past the token lifetime) returns the user to login with a message', async () => {
    await register();
    await dev('/dev/advance-clock', { days: 2 }); // the real server now considers the 24 h token expired
    await nav('Usage');
    expect(await screen.findByRole('heading', { name: 'Sign in to your account' }, slow)).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Your session has expired');
    expect(window.localStorage.getItem('subcycle.session')).toBeNull();
  }, LONG);
});

describe('real backend: plans, subscription lifecycle and billing', () => {
  it('free plan: subscribe, see live usage limits from the plan, generate reports, see usage history', async () => {
    await register();
    await subscribeFree();
    expect(await screen.findByRole('heading', { name: 'Dashboard' }, slow)).toBeInTheDocument();
    expect(await screen.findByRole('progressbar', { name: 'API calls used' }, slow)).toHaveAttribute('aria-valuemax', '100'); // seeded plan limit
    expect(screen.getByRole('region', { name: 'Current plan' })).toHaveTextContent('Free');

    await nav('Usage');
    await userEvent.click(await screen.findByRole('button', { name: 'Generate report' }, slow));
    expect(await screen.findByText('Demo report #1', undefined, slow)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Generate report' }));
    expect(await screen.findByText('Demo report #2', undefined, slow)).toBeInTheDocument();
    expect(await screen.findByText('2 / 100', undefined, slow)).toBeInTheDocument();
    const history = await screen.findByRole('table', { name: /Usage per billing period/ }, slow);
    expect(within(history).getByText(/API calls: 2/)).toBeInTheDocument();
    expect(within(history).getByText('Current')).toBeInTheDocument();
  }, LONG);

  it('paid subscribe, upgrade with a real server-side proration preview, and the resulting invoices', async () => {
    const { email } = await register();
    await subscribePro();
    await screen.findByRole('heading', { name: 'Dashboard' }, slow);
    expect(await screen.findByText('₹499 / month', undefined, slow)).toBeInTheDocument();

    await nav('Billing');
    const invoices = await screen.findByRole('table', { name: 'Invoices, newest first' }, slow);
    expect(within(invoices).getByText('Subscription payment')).toBeInTheDocument();
    expect(within(invoices).getByText('Paid')).toBeInTheDocument();
    expect(within(await screen.findByRole('table', { name: /Payment attempts and refunds/ }, slow)).getByText('Succeeded')).toBeInTheDocument();

    await nav('Manage plan');
    await userEvent.click(await screen.findByRole('button', { name: 'Upgrade to Business' }, slow));
    const dialog = screen.getByRole('dialog');
    const confirm = await within(dialog).findByRole('button', { name: /Confirm and pay ₹/ }, slow);
    expect(within(dialog).getByText(/Estimated charge now/)).toBeInTheDocument();
    expect(screen.queryByText(/You are now on Business/)).not.toBeInTheDocument();
    await userEvent.dblClick(confirm); // a double click must create ONE billing intention
    expect(await screen.findByText('You are now on Business.', undefined, slow)).toBeInTheDocument();
    await waitFor(() => expect(within(screen.getByRole('region', { name: 'Current plan' })).getByText('Business')).toBeInTheDocument(), slow);

    const id = await userId(email);
    const counts = await pool.query<{ ops: string; invoices: string }>(
      `SELECT (SELECT count(*) FROM billing_operations WHERE user_id = $1 AND operation_type = 'charge') AS ops,
              (SELECT count(*) FROM invoices i JOIN subscriptions s ON s.id = i.subscription_id WHERE s.user_id = $1) AS invoices`,
      [id],
    );
    expect(counts.rows[0]).toEqual({ ops: '2', invoices: '2' }); // initial + exactly ONE upgrade charge

    await nav('Billing');
    const after = await screen.findByRole('table', { name: 'Invoices, newest first' }, slow);
    await waitFor(() => expect(within(after).getByText('Upgrade (prorated)')).toBeInTheDocument(), slow);
    await nav('History');
    expect(await screen.findByText('Upgraded to Business', undefined, slow)).toBeInTheDocument();
    expect(screen.getByText('Subscribed to Pro')).toBeInTheDocument();
  }, LONG);

  it('schedule a downgrade, pause and resume, cancel and reactivate against the real state machine', async () => {
    await register();
    await subscribePro();
    await nav('Manage plan');

    await userEvent.click(await screen.findByRole('button', { name: 'Schedule downgrade to Free' }, slow));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Schedule downgrade' }));
    await see(/Downgrade to Free is scheduled for/);
    await see('Scheduled change to Free');

    await userEvent.click(await screen.findByRole('button', { name: 'Pause subscription' }, slow));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Pause subscription' }));
    await see('Your subscription is paused.');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel at end of period' })).toBeDisabled(), slow); // 409 rule from the backend, mirrored as a hint
    await see('Resume your subscription before canceling it.');

    await userEvent.click(screen.getByRole('button', { name: 'Resume subscription' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Resume subscription' }));
    await see(/active again/);

    await userEvent.click(await screen.findByRole('button', { name: 'Cancel at end of period' }, slow));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel at period end' }));
    await see(/Cancellation scheduled. You keep access until/);
    await userEvent.click(await screen.findByRole('button', { name: 'Keep my subscription (undo cancellation)' }, slow));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Undo cancellation' }));
    await see(/Your cancellation was undone/);
  }, LONG);

  it('shows the backend error when it rejects a request the UI offered (state changed behind its back)', async () => {
    const { email } = await register();
    await subscribeFree();
    await nav('Manage plan');
    const pauseButton = await screen.findByRole('button', { name: 'Pause subscription' }, slow);
    // Someone else (another tab) pauses the subscription directly in the database.
    await pool.query(`UPDATE subscriptions SET status = 'paused', paused_at = $2 WHERE user_id = $1 AND status = 'active'`, [await userId(email), await fakeNow()]);
    await userEvent.click(pauseButton);
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Pause subscription' }));
    expect(await within(screen.getByRole('dialog')).findByRole('alert', undefined, slow)).toHaveTextContent('Cannot pause a paused subscription');
  }, LONG);
});

describe('real backend: limit enforcement is server-side', () => {
  it('the third demo report is refused by the server once a limit of 2 is reached, and nothing extra is counted', async () => {
    await pool.query(`UPDATE plans SET limits = '{"api_calls": 2, "projects": 1, "seats": 1}'::jsonb WHERE code = 'free'`);
    try {
      const { email } = await register();
      await subscribeFree();
      await nav('Usage');
      for (const n of [1, 2]) {
        await userEvent.click(await screen.findByRole('button', { name: 'Generate report' }, slow));
        expect(await screen.findByText(`Demo report #${n}`, undefined, slow)).toBeInTheDocument();
      }
      await userEvent.click(screen.getByRole('button', { name: 'Generate report' }));
      const banner = await screen.findByRole('alert', undefined, slow);
      expect(banner).toHaveTextContent('Limit reached: no report was generated');
      expect(banner).toHaveTextContent('used 2 of 2 API calls');
      expect(await screen.findByText('Limit reached', { selector: 'span' }, slow)).toBeInTheDocument();
      const rows = await pool.query<{ reports: string; used: string }>(
        `SELECT (SELECT count(*) FROM demo_reports WHERE user_id = $1) AS reports, (SELECT COALESCE(sum(quantity), 0) FROM usage_records r JOIN subscriptions s ON s.id = r.subscription_id WHERE s.user_id = $1) AS used`,
        [await userId(email)],
      );
      expect(rows.rows[0]).toEqual({ reports: '2', used: '2' });
    } finally {
      await pool.query(`UPDATE plans SET limits = '{"api_calls": 100, "projects": 1, "seats": 1}'::jsonb WHERE code = 'free'`);
    }
  }, LONG);
});

describe('real backend: the period boundary and past_due follow the server (B19)', () => {
  it('period end: the UI shows "renewal processing", usage is refused by the server, and the screen updates itself when the job renews', async () => {
    const { email, view } = await register();
    await subscribeFree();
    const now = await fakeNow();
    await pool.query('UPDATE subscriptions SET current_period_end = $2 WHERE user_id = $1 AND status = $3', [await userId(email), new Date(now.getTime() + 120_000), 'active']);

    view.unmount();
    mount('/');
    expect(await screen.findByRole('region', { name: 'Current plan' }, slow)).toHaveTextContent('Active');
    expect(screen.queryByText('Your renewal is being processed')).not.toBeInTheDocument();

    await dev('/dev/advance-clock', { ms: 180_000 }); // 3 minutes: the stored period has now ended
    cleanup();
    mount('/'); // a fresh load sees the server's current verdict
    expect(await screen.findAllByText('Your renewal is being processed', undefined, slow)).not.toHaveLength(0);
    expect((await screen.findAllByText('Renewal processing', undefined, slow)).length).toBeGreaterThan(0);

    await nav('Usage');
    expect(await screen.findAllByText('Usage is currently not allowed', undefined, slow)).not.toHaveLength(0);
    await userEvent.click(await screen.findByRole('button', { name: 'Generate report' }, slow));
    expect(await screen.findByRole('alert', undefined, slow)).toHaveTextContent('renewal is being processed');

    await nav('Dashboard');
    expect(await screen.findAllByText('Your renewal is being processed', undefined, slow)).not.toHaveLength(0);
    await dev('/dev/run-renewals'); // the real renewal job
    // No user action: the dashboard polls and follows the server.
    await waitFor(() => expect(screen.queryByText('Your renewal is being processed')).not.toBeInTheDocument(), { timeout: 15_000 });
    expect(within(screen.getByRole('region', { name: 'Current plan' })).getByText('Active')).toBeInTheDocument();
    await nav('Usage');
    await userEvent.click(await screen.findByRole('button', { name: 'Generate report' }, slow));
    expect(await screen.findByText(/Demo report #/, undefined, slow)).toBeInTheDocument();
  }, 90_000);

  it('past_due: grace period banner from the server, access ends at exactly +72h as the server decides, and a cancel keeps the grace', async () => {
    const { email } = await register();
    await subscribeFree();
    const now = await fakeNow();
    const since = new Date(now.getTime() - 3_600_000);
    await pool.query(
      `UPDATE subscriptions SET status = 'past_due', past_due_since = $2, next_retry_at = $3, current_period_end = $4, current_period_start = $5 WHERE user_id = $1 AND status = 'active'`,
      [await userId(email), since, new Date(since.getTime() + 86_400_000), new Date(now.getTime() - 60_000), new Date(now.getTime() - 86_400_000)],
    );
    cleanup(); // "reload" the app so it reads the server's current state
    mount('/');
    expect(await screen.findByText('Your last payment failed', undefined, slow)).toBeInTheDocument();
    expect(screen.getByText('Payment failed (grace period)')).toBeInTheDocument();
    expect(screen.getByText('Allowed')).toBeInTheDocument();

    await nav('Manage plan');
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel at end of period' }, slow));
    expect(screen.getByRole('dialog')).toHaveTextContent('stop trying to charge you');
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel at period end' }));
    expect(await screen.findByText(/We will not try to charge you again/, undefined, slow)).toBeInTheDocument();

    await dev('/dev/advance-clock', { days: 4 }); // beyond the 72 h grace (this also outlives the 24 h session token)
    cleanup();
    mount('/');
    // The real server now rejects the old token, so the app asks for a fresh sign-in (its job: never crash, say why).
    await screen.findByRole('heading', { name: 'Sign in to your account' }, slow);
    expect(screen.getByRole('status')).toHaveTextContent('Your session has expired');
    await userEvent.type(screen.getByLabelText('Email'), email);
    await userEvent.type(screen.getByLabelText('Password'), PASSWORD);
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Access is blocked: payment is overdue', undefined, slow)).toBeInTheDocument();
    expect(screen.getByText('Past due (access blocked)')).toBeInTheDocument();
  }, 90_000);
});

describe('real backend: payment attempts and refunds are visible', () => {
  it('shows a pending payment as in progress and a failed refund as needing attention, from the real /billing/operations', async () => {
    const { email } = await register();
    await subscribePro();
    const id = await userId(email);
    const charge = (await pool.query<{ id: string }>(`SELECT id FROM billing_operations WHERE user_id = $1 AND operation_type = 'charge' LIMIT 1`, [id])).rows[0]!.id;
    const sub = (await pool.query<{ id: string }>('SELECT id FROM subscriptions WHERE user_id = $1', [id])).rows[0]!.id;
    await pool.query(
      `INSERT INTO billing_operations (user_id, subscription_id, obligation_key, attempt, idempotency_key, operation_type, refund_of_operation_id, reason, amount_cents, status, error_message, created_at, updated_at)
       VALUES ($1, $2, 'upgrade:test:1', 1, 'refund:upgrade:test:1:attempt:1', 'refund', $3, 'state_changed', 33803, 'failed', 'refund_not_allowed: The provider refuses this refund', now(), now())`,
      [id, sub, charge],
    );
    await pool.query(
      `INSERT INTO billing_operations (user_id, subscription_id, obligation_key, attempt, idempotency_key, operation_type, amount_cents, status, created_at, updated_at)
       VALUES ($1, $2, 'renewal:test:1', 1, 'charge:renewal:test:1:attempt:1', 'charge', 49900, 'pending', now(), now())`,
      [id, sub],
    );
    await nav('Billing');
    const table = await screen.findByRole('table', { name: /Payment attempts and refunds/ }, slow);
    expect(within(table).getByText('Refund failed')).toBeInTheDocument();
    expect(within(table).getByText('In progress')).toBeInTheDocument();
    expect(await screen.findByText('A refund could not be completed')).toBeInTheDocument();
    expect(screen.getByText('A payment is still being confirmed')).toBeInTheDocument();
    expect(within(table).getByText('Succeeded')).toBeInTheDocument(); // the real initial payment stays distinct
  }, LONG);
});
