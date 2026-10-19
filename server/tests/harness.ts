import type { Express } from 'express';
import request from 'supertest';
import { createApp } from '../src/app';
import { MockProvider } from '../src/billing/mockProvider';
import type { Pool } from '../src/db/pool';
import { FakeClock } from '../src/lib/clock';
import type { BillingDeps } from '../src/services/billingOperations';
import { testAuthSettings } from './helpers';

export const T0 = '2026-01-01T00:00:00.000Z';
export const DAY = 86_400_000;
export const PASSWORD = 'correct horse battery';

export interface Harness {
  pool: Pool;
  clock: FakeClock;
  provider: MockProvider;
  app: Express;
  deps: BillingDeps;
}

export function createHarness(pool: Pool, opts: { start?: string; timeoutMs?: number; provider?: MockProvider; usageMax?: number; dev?: boolean; fakeClockEnabled?: boolean; corsOrigins?: string[]; authMax?: number } = {}): Harness {
  const clock = new FakeClock(opts.start ?? T0);
  const provider = opts.provider ?? new MockProvider();
  const timeoutMs = opts.timeoutMs ?? 5000;
  const app = createApp({
    pool,
    clock,
    corsOrigins: opts.corsOrigins ?? [],
    auth: testAuthSettings({ ttlSeconds: 10 * 365 * 86_400, ...(opts.authMax ? { max: opts.authMax } : {}) }), // tokens must outlive the fake clock jumps
    billing: { provider, providerTimeoutMs: timeoutMs },
    usageRateLimit: { windowMs: 60_000, max: opts.usageMax ?? 100_000 },
    ...(opts.dev ? { dev: { fakeClock: opts.fakeClockEnabled === false ? null : clock } } : {}),
  });
  return { pool, clock, provider, app, deps: { pool, clock, provider, providerTimeoutMs: timeoutMs } };
}

export interface User {
  token: string;
  userId: string;
  email: string;
}

export async function signup(h: Harness, email = 'a@example.com'): Promise<User> {
  const res = await request(h.app).post('/auth/register').send({ email, password: PASSWORD, name: 'Test' });
  if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${JSON.stringify(res.body)}`);
  const body = res.body as { token: string; user: { id: string } };
  return { token: body.token, userId: body.user.id, email };
}

/** Thin authenticated wrapper around supertest. */
export function api(h: Harness, user: User) {
  const auth = (r: request.Test, headers: Record<string, string>) => {
    r.set('Authorization', `Bearer ${user.token}`);
    for (const [k, v] of Object.entries(headers)) r.set(k, v);
    return r;
  };
  return {
    get: (path: string, headers: Record<string, string> = {}) => auth(request(h.app).get(path), headers),
    post: (path: string, body?: object, headers: Record<string, string> = {}) => auth(request(h.app).post(path), headers).send(body),
    del: (path: string, headers: Record<string, string> = {}) => auth(request(h.app).delete(path), headers),
  };
}

export async function planIds(pool: Pool): Promise<Record<string, string>> {
  const { rows } = await pool.query<{ id: string; code: string }>('SELECT id, code FROM plans');
  return Object.fromEntries(rows.map((r) => [r.code, r.id]));
}

export async function count(pool: Pool, sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM (${sql}) q`, params);
  return Number(rows[0]!.n);
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Cross-table invariants between invoices and billing operations (docs/DECISIONS.md B12b). Returns problems found.
 */
export async function billingInvariantViolations(pool: Pool): Promise<string[]> {
  const problems: string[] = [];
  const q = async (sql: string, msg: string) => {
    const { rows } = await pool.query<{ id: string }>(sql);
    for (const r of rows) problems.push(`${msg}: ${r.id}`);
  };
  await q(
    `SELECT i.id FROM invoices i WHERE i.status = 'paid'
       AND NOT EXISTS (SELECT 1 FROM billing_operations o WHERE o.obligation_key = i.obligation_key AND o.operation_type = 'charge' AND o.status = 'succeeded')`,
    'paid invoice without a succeeded charge',
  );
  await q(
    `SELECT i.id FROM invoices i WHERE i.status = 'failed'
       AND (EXISTS (SELECT 1 FROM billing_operations o WHERE o.obligation_key = i.obligation_key AND o.operation_type = 'charge' AND o.status = 'succeeded')
            OR NOT EXISTS (SELECT 1 FROM billing_operations o WHERE o.obligation_key = i.obligation_key AND o.operation_type = 'charge' AND o.status = 'failed'))`,
    'failed invoice inconsistent with its operations',
  );
  await q(
    `SELECT i.id FROM invoices i WHERE i.status = 'refunded'
       AND NOT EXISTS (SELECT 1 FROM billing_operations r JOIN billing_operations c ON c.id = r.refund_of_operation_id
                       WHERE c.obligation_key = i.obligation_key AND r.operation_type = 'refund' AND r.status = 'succeeded')`,
    'refunded invoice without a succeeded refund',
  );
  await q(
    `SELECT i.id FROM invoices i WHERE i.status IN ('paid', 'refunded')
       AND NOT EXISTS (SELECT 1 FROM billing_operations o WHERE o.obligation_key = i.obligation_key AND o.operation_type = 'charge'
                       AND o.status = 'succeeded' AND o.amount_cents = i.amount_cents AND o.invoice_id = i.id)`,
    'paid/refunded invoice amount differs from the charge actually collected',
  );
  await q(
    `SELECT c.id FROM billing_operations c WHERE c.operation_type = 'charge' AND c.status = 'succeeded' AND c.invoice_id IS NOT NULL
       AND (SELECT status FROM invoices WHERE id = c.invoice_id) NOT IN ('paid', 'refunded')`,
    'succeeded charge linked to a non-paid invoice',
  );
  return problems;
}

/**
 * Deterministic barrier: resolves once some backend is BLOCKED waiting on a lock while running a statement containing
 * `fragment` (polls pg_stat_activity; condition-based, not a fixed sleep). Fails after `timeoutMs`.
 */
export async function waitUntilBlocked(pool: Pool, fragment: string, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await pool.query(
      `SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE $1 AND pid <> pg_backend_pid()`,
      [`%${fragment}%`],
    );
    if (rows.length > 0) return;
    if (Date.now() > deadline) throw new Error(`no backend became blocked on a statement containing "${fragment}"`);
    await sleep(5);
  }
}

/** Counters must equal the sum of their ledger events (docs/DECISIONS.md B13a). Returns problems found. */
export async function usageInvariantViolations(pool: Pool): Promise<string[]> {
  const problems: string[] = [];
  const counters = await pool.query<{ id: string }>(
    `SELECT r.id FROM usage_records r
     WHERE r.quantity <> COALESCE((SELECT sum(e.quantity) FROM usage_events e
                                   WHERE e.subscription_id = r.subscription_id AND e.metric = r.metric AND e.period_start = r.period_start), 0)`,
  );
  for (const r of counters.rows) problems.push(`counter != ledger sum: ${r.id}`);
  const orphans = await pool.query<{ id: string }>(
    `SELECT e.id FROM usage_events e WHERE NOT EXISTS (
       SELECT 1 FROM usage_records r WHERE r.subscription_id = e.subscription_id AND r.metric = e.metric AND r.period_start = e.period_start)`,
  );
  for (const r of orphans.rows) problems.push(`ledger event without a counter: ${r.id}`);
  return problems;
}

/** Condition-based wait (polls); fails after `timeoutMs`. Use instead of fixed sleeps. */
export async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error('waitFor: condition not met in time');
    await sleep(5);
  }
}
