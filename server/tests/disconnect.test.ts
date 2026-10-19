import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from '../src/db/pool';
import { enforceLimit } from '../src/middleware/enforceLimit';
import { errorHandler } from '../src/middleware/errorHandler';
import { createTestPool, resetData } from './helpers';
import { api, createHarness, planIds, signup, waitFor, type Harness, type User } from './harness';

/**
 * A client that disconnects while a metered request is in flight must not leave usage committed or a connection stuck
 * in an open transaction (docs/DECISIONS.md B13a). Uses a REAL HTTP server and a REAL socket teardown; the handler is
 * parked on a deferred promise so there is no timing guesswork.
 */
let pool: Pool;
let h: Harness;
let alice: User;

beforeAll(() => {
  pool = createTestPool();
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await resetData(pool);
  h = createHarness(pool);
  const ids = await planIds(pool);
  alice = await signup(h, 'alice@example.com');
  await api(h, alice).post('/subscriptions', { planId: ids.free });
});

const openTransactions = async () =>
  Number((await pool.query<{ n: string }>(`SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND state LIKE 'idle in transaction%'`)).rows[0]!.n);
const usageTotals = async () => ({
  counter: Number((await pool.query<{ q: string | null }>('SELECT sum(quantity) AS q FROM usage_records')).rows[0]!.q ?? 0),
  ledger: Number((await pool.query<{ q: string | null }>('SELECT sum(quantity) AS q FROM usage_events')).rows[0]!.q ?? 0),
});

function slowServer() {
  let enteredResolve!: () => void;
  let closedResolve!: () => void;
  let releaseResolve!: () => void;
  const entered = new Promise<void>((r) => (enteredResolve = r));
  const closed = new Promise<void>((r) => (closedResolve = r));
  const gate = new Promise<void>((r) => (releaseResolve = r));
  let answered = false;

  const app = express();
  app.use((req, _res, next) => {
    req.user = { id: String(req.header('x-user')), email: 'x', name: 'x', createdAt: '' };
    next();
  });
  app.post('/slow', enforceLimit({ pool, clock: h.clock }, 'api_calls', 5), async (_req, res) => {
    res.once('close', closedResolve);
    enteredResolve();
    await gate; // the handler is still working when the client disconnects
    answered = true;
    res.status(200).json({ ok: true });
  });
  app.use(errorHandler);
  const server = http.createServer(app).listen(0);
  return { server, port: (server.address() as AddressInfo).port, entered, closed, release: releaseResolve, answered: () => answered };
}

describe('client disconnect during a metered request', () => {
  it('rolls back the usage and releases the connection when the client goes away before the handler finishes', async () => {
    const s = slowServer();
    try {
      const req = http.request({ port: s.port, method: 'POST', path: '/slow', headers: { 'x-user': alice.userId } });
      req.on('error', () => undefined); // the destroyed socket is expected
      req.end();

      await s.entered;
      expect(await openTransactions()).toBe(1); // the metered transaction is open while the handler works
      expect(await usageTotals()).toEqual({ counter: 0, ledger: 0 }); // nothing is visible until commit

      req.destroy(); // client disconnects
      await s.closed; // the server has observed the close
      s.release(); // the handler now finishes "successfully"
      await waitFor(async () => (await openTransactions()) === 0, 5000);

      expect(s.answered()).toBe(true);
      expect(await usageTotals()).toEqual({ counter: 0, ledger: 0 }); // abandoned => rolled back, not committed
      expect(pool.waitingCount).toBe(0);
    } finally {
      s.release();
      s.server.close();
      s.server.closeAllConnections();
    }
    // the connection that was held is usable again and the same request now commits normally
    const ok = slowServer();
    try {
      ok.release();
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request({ port: ok.port, method: 'POST', path: '/slow', headers: { 'x-user': alice.userId } }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        });
        req.on('error', reject);
        req.end();
      });
      expect(status).toBe(200);
      expect(await usageTotals()).toEqual({ counter: 5, ledger: 5 });
      expect(await openTransactions()).toBe(0);
    } finally {
      ok.server.close();
      ok.server.closeAllConnections();
    }
  });

  it('many abandoned requests never exhaust the pool (more abandoned requests than pool connections)', async () => {
    for (let i = 0; i < 8; i++) {
      const s = slowServer();
      try {
        const req = http.request({ port: s.port, method: 'POST', path: '/slow', headers: { 'x-user': alice.userId } });
        req.on('error', () => undefined);
        req.end();
        await s.entered;
        req.destroy();
        await s.closed;
        s.release();
        await waitFor(async () => (await openTransactions()) === 0, 5000);
      } finally {
        s.server.close();
        s.server.closeAllConnections();
      }
    }
    for (let i = 0; i < 8; i++) expect((await pool.query('SELECT 1')).rowCount).toBe(1);
    expect(pool.waitingCount).toBe(0);
    expect(await usageTotals()).toEqual({ counter: 0, ledger: 0 });
  });
});
