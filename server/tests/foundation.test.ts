import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { parseConfig } from '../src/config';
import { createPool, type Pool } from '../src/db/pool';
import { withTransaction } from '../src/db/transaction';
import { errorHandler } from '../src/middleware/errorHandler';
import { FakeClock, SystemClock } from '../src/lib/clock';
import { AppError, conflict, validationError, type ErrorBody } from '../src/lib/errors';
import { divRoundHalfUp } from '../src/lib/money';
import { createTestPool, resetData, testAuthSettings, testBilling } from './helpers';

let pool: Pool;
beforeAll(async () => {
  pool = createTestPool();
  await resetData(pool);
});
afterAll(async () => {
  await pool.end();
});

describe('Clock', () => {
  it('FakeClock is controllable and returns copies', () => {
    const clock = new FakeClock('2026-01-31T00:00:00Z');
    const a = clock.now();
    a.setUTCFullYear(1999);
    expect(clock.now().toISOString()).toBe('2026-01-31T00:00:00.000Z');
    clock.advanceMs(86_400_000);
    expect(clock.now().toISOString()).toBe('2026-02-01T00:00:00.000Z');
    clock.set('2030-05-05T05:05:05Z');
    expect(clock.now().toISOString()).toBe('2030-05-05T05:05:05.000Z');
    expect(() => new FakeClock('nope')).toThrow();
  });

  it('SystemClock returns a current Date', () => {
    expect(Math.abs(new SystemClock().now().getTime() - Date.now())).toBeLessThan(1000);
  });
});

describe('divRoundHalfUp', () => {
  it('rounds half up exactly once', () => {
    expect(divRoundHalfUp(1n, 2n)).toBe(1n); // 0.5 -> 1
    expect(divRoundHalfUp(1n, 3n)).toBe(0n);
    expect(divRoundHalfUp(2n, 3n)).toBe(1n);
    expect(divRoundHalfUp(5n, 2n)).toBe(3n); // 2.5 -> 3
    expect(divRoundHalfUp(0n, 7n)).toBe(0n);
    expect(divRoundHalfUp(100_000n * 3n, 3n)).toBe(100_000n);
  });
  it('rejects bad input', () => {
    expect(() => divRoundHalfUp(1n, 0n)).toThrow(RangeError);
    expect(() => divRoundHalfUp(-1n, 2n)).toThrow(RangeError);
  });
});

describe('config', () => {
  it('requires DATABASE_URL and applies defaults', () => {
    expect(() => parseConfig({})).toThrow(/DATABASE_URL/);
    const c = parseConfig({ DATABASE_URL: 'postgres://x' });
    expect(c).toMatchObject({ NODE_ENV: 'development', PORT: 4000, FAKE_CLOCK: false, CORS_ORIGINS: ['http://localhost:5173'] });
  });
  it('parses the CORS allow-list and refuses FAKE_CLOCK in production', () => {
    expect(parseConfig({ DATABASE_URL: 'x', CORS_ORIGINS: 'http://a.test, http://b.test' }).CORS_ORIGINS).toEqual(['http://a.test', 'http://b.test']);
    expect(() => parseConfig({ DATABASE_URL: 'x', NODE_ENV: 'production', FAKE_CLOCK: 'true' })).toThrow(/FAKE_CLOCK/);
  });
  it('does not echo secret values in validation errors', () => {
    expect(() => parseConfig({ DATABASE_URL: 'x', PORT: 'secret-value-123' })).toThrow(/PORT/);
    try {
      parseConfig({ DATABASE_URL: 'x', PORT: 'secret-value-123' });
    } catch (e) {
      expect((e as Error).message).not.toContain('secret-value-123');
    }
  });
});

describe('withTransaction', () => {
  it('commits on success and returns the value', async () => {
    const value = await withTransaction(pool, async (c) => {
      await c.query(`INSERT INTO users (email, password_hash, name) VALUES ('tx1@example.com', 'x', 'n')`);
      return 42;
    });
    expect(value).toBe(42);
    const { rowCount } = await pool.query(`SELECT 1 FROM users WHERE email = 'tx1@example.com'`);
    expect(rowCount).toBe(1);
  });

  it('rolls back on error, re-throws the original error, and releases the client', async () => {
    const boom = new Error('boom');
    await expect(
      withTransaction(pool, async (c) => {
        await c.query(`INSERT INTO users (email, password_hash, name) VALUES ('tx2@example.com', 'x', 'n')`);
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect((await pool.query(`SELECT 1 FROM users WHERE email = 'tx2@example.com'`)).rowCount).toBe(0);
  });

  it('does not leak clients: pool stays usable after many failures', async () => {
    const tiny = createPool(pool.options.connectionString!, { max: 2 });
    try {
      for (let i = 0; i < 10; i++) {
        await expect(withTransaction(tiny, () => Promise.reject(new Error('x')))).rejects.toThrow('x');
      }
      await withTransaction(tiny, async (c) => {
        await c.query('SELECT 1');
      });
      expect(tiny.waitingCount).toBe(0);
      expect(tiny.idleCount).toBe(tiny.totalCount);
    } finally {
      await tiny.end();
    }
  });

  it('rolls back on a database error mid-transaction (aborted tx) and leaves the pool healthy', async () => {
    await expect(
      withTransaction(pool, async (c) => {
        await c.query('SELECT 1/0');
      }),
    ).rejects.toMatchObject({ code: '22012' });
    expect((await pool.query('SELECT 1 AS ok')).rows[0]).toEqual({ ok: 1 });
  });

  it('isolates concurrent transactions: FOR UPDATE serialises writers', async () => {
    await pool.query(`INSERT INTO users (email, password_hash, name) VALUES ('lock@example.com', 'x', '0')`);
    const bump = () =>
      withTransaction(pool, async (c) => {
        const { rows } = await c.query<{ name: string }>(`SELECT name FROM users WHERE email = 'lock@example.com' FOR UPDATE`);
        await new Promise((r) => setTimeout(r, 20));
        await c.query(`UPDATE users SET name = $1 WHERE email = 'lock@example.com'`, [String(Number(rows[0]!.name) + 1)]);
      });
    await Promise.all([bump(), bump(), bump(), bump()]);
    const { rows } = await pool.query<{ name: string }>(`SELECT name FROM users WHERE email = 'lock@example.com'`);
    expect(rows[0]!.name).toBe('4');
  });
});

describe('app: health, errors, security headers', () => {
  const clock = new FakeClock('2026-03-01T10:00:00Z');
  const makeApp = (p: Pool = pool) => createApp({ pool: p, clock, corsOrigins: ['http://allowed.test'], auth: testAuthSettings(), billing: testBilling() });

  it('GET /health reports ok with DB connectivity and clock time', async () => {
    const res = await request(makeApp()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', database: 'up', time: '2026-03-01T10:00:00.000Z' });
  });

  it('GET /health returns 503 when the database is unreachable', async () => {
    const dead = createPool('postgres://nobody:nope@127.0.0.1:1/none', { connectionTimeoutMillis: 500 });
    try {
      const res = await request(makeApp(dead)).get('/health');
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ status: 'degraded', database: 'down' });
    } finally {
      await dead.end();
    }
  });

  it('unknown routes use the standard error shape', async () => {
    const res = await request(makeApp()).get('/nope');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'ROUTE_NOT_FOUND', message: 'Route not found', details: {} } });
  });

  it('malformed JSON and oversized bodies return standard 400 / 413 errors', async () => {
    const app = makeApp();
    const bad = await request(app).post('/health').set('Content-Type', 'application/json').send('{not json');
    expect(bad.status).toBe(400);
    expect((bad.body as ErrorBody).error.code).toBe('VALIDATION_ERROR');
    const big = await request(app).post('/health').set('Content-Type', 'application/json').send(JSON.stringify({ x: 'a'.repeat(200_000) }));
    expect(big.status).toBe(413);
    expect((big.body as ErrorBody).error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('sets helmet headers, hides x-powered-by, and applies the CORS allow-list', async () => {
    const app = makeApp();
    const ok = await request(app).get('/health').set('Origin', 'http://allowed.test');
    expect(ok.headers['x-content-type-options']).toBe('nosniff');
    expect(ok.headers['x-powered-by']).toBeUndefined();
    expect(ok.headers['access-control-allow-origin']).toBe('http://allowed.test');
    const denied = await request(app).get('/health').set('Origin', 'http://evil.test');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('AppError helpers carry status, code and details; unknown errors become a generic 500 without leaking', async () => {
    expect(validationError('bad', { field: 'x' }).toBody()).toEqual({ error: { code: 'VALIDATION_ERROR', message: 'bad', details: { field: 'x' } } });
    expect(conflict('INVALID_TRANSITION', 'no').status).toBe(409);
    expect(new AppError(402, 'X', 'm').toBody().error.details).toEqual({});

    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const mini = express();
    mini.get('/boom', () => {
      throw new Error('SECRET db password=hunter2');
    });
    mini.get('/app-error', (_req, _res, next) => next(conflict('INVALID_TRANSITION', 'Cannot pause', { status: 'canceled' })));
    mini.use(errorHandler);
    const boom = await request(mini).get('/boom');
    expect(boom.status).toBe(500);
    expect(boom.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred', details: {} } });
    expect(JSON.stringify(boom.body)).not.toContain('hunter2');
    const known = await request(mini).get('/app-error');
    expect(known.status).toBe(409);
    expect((known.body as ErrorBody).error).toEqual({ code: 'INVALID_TRANSITION', message: 'Cannot pause', details: { status: 'canceled' } });
    spy.mockRestore();
  });
});
