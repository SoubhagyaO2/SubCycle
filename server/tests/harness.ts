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

export function createHarness(pool: Pool, opts: { start?: string; timeoutMs?: number; provider?: MockProvider } = {}): Harness {
  const clock = new FakeClock(opts.start ?? T0);
  const provider = opts.provider ?? new MockProvider();
  const timeoutMs = opts.timeoutMs ?? 5000;
  const app = createApp({
    pool,
    clock,
    corsOrigins: [],
    auth: testAuthSettings({ ttlSeconds: 10 * 365 * 86_400 }), // tokens must outlive the fake clock jumps
    billing: { provider, providerTimeoutMs: timeoutMs },
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
    `SELECT c.id FROM billing_operations c WHERE c.operation_type = 'charge' AND c.status = 'succeeded' AND c.invoice_id IS NOT NULL
       AND (SELECT status FROM invoices WHERE id = c.invoice_id) NOT IN ('paid', 'refunded')`,
    'succeeded charge linked to a non-paid invoice',
  );
  return problems;
}
