import type { Express } from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { parseConfig } from '../src/config';
import type { Pool } from '../src/db/pool';
import { createTestPool, testAuthSettings, testBilling } from './helpers';

const LIMIT = 2;
const base = { DATABASE_URL: 'postgres://x' };
const production = { ...base, NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(40), CORS_ORIGINS: 'https://app.example.com' };

describe('TRUST_PROXY configuration', () => {
  it('is off by default, so local development is unchanged', () => {
    expect(parseConfig(base).TRUST_PROXY).toBe(false);
    expect(parseConfig({ ...base, TRUST_PROXY: 'false' }).TRUST_PROXY).toBe(false);
    expect(parseConfig({ ...production }).TRUST_PROXY).toBe(false);
  });

  it('accepts a proxy hop count, including in production', () => {
    expect(parseConfig({ ...production, TRUST_PROXY: '1' }).TRUST_PROXY).toBe(1);
    expect(parseConfig({ ...base, TRUST_PROXY: ' 2 ' }).TRUST_PROXY).toBe(2);
  });

  it('rejects "true" and anything that is not a small hop count, because trusting every hop lets clients spoof their IP', () => {
    for (const bad of ['true', 'TRUE', 'yes', '0', '-1', '6', '1.5', '', 'loopback', '10.0.0.0/8']) {
      expect(() => parseConfig({ ...base, TRUST_PROXY: bad }), bad).toThrow(/TRUST_PROXY/);
    }
  });
});

describe('client IP behind a trusted proxy (per-IP login limiter)', () => {
  let pool: Pool;
  beforeAll(() => {
    pool = createTestPool();
  });
  afterAll(async () => {
    await pool.end();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const makeApp = (trustProxy?: number | false): Express =>
    createApp({
      pool,
      clock: { now: () => new Date('2026-03-01T10:00:00Z') },
      corsOrigins: [],
      auth: testAuthSettings({ max: LIMIT }),
      billing: testBilling(),
      ...(trustProxy === undefined ? {} : { trustProxy }),
    });

  const login = (app: Express, forwardedFor?: string) => {
    const req = request(app).post('/auth/login');
    if (forwardedFor) req.set('X-Forwarded-For', forwardedFor);
    return req.send({ email: 'nobody@example.com', password: 'whatever-123' });
  };

  it('does not change Express settings by default', () => {
    expect(makeApp().get('trust proxy')).toBe(false);
    expect(makeApp(false).get('trust proxy')).toBe(false);
    expect(makeApp(1).get('trust proxy')).toBe(1);
  });

  it('by default ignores X-Forwarded-For: changing it does not escape the limit', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined); // the limiter library warns about an unexpected header
    const app = makeApp();
    for (let i = 0; i < LIMIT; i++) expect((await login(app, `198.51.100.${i + 1}`)).status).toBe(401);
    expect((await login(app, '198.51.100.99')).status).toBe(429);
    expect((await login(app)).status).toBe(429);
  });

  it('with one trusted proxy, different clients (the address the proxy appends) get separate limits', async () => {
    const app = makeApp(1);
    for (let i = 0; i < LIMIT; i++) expect((await login(app, '203.0.113.10')).status).toBe(401);
    expect((await login(app, '203.0.113.10')).status).toBe(429); // client A is limited
    expect((await login(app, '203.0.113.11')).status).toBe(401); // client B is not
  });

  it('with one trusted proxy, a client cannot dodge its limit by prepending fake X-Forwarded-For entries', async () => {
    const app = makeApp(1);
    // The trusted proxy appends the real peer address to whatever the client sent; only that last entry is used.
    for (let i = 0; i < LIMIT; i++) expect((await login(app, `10.0.0.${i + 1}, 203.0.113.20`)).status).toBe(401);
    expect((await login(app, '1.2.3.4, 5.6.7.8, 203.0.113.20')).status).toBe(429);
    expect((await login(app, '9.9.9.9, 203.0.113.20')).status).toBe(429);
    expect((await login(app, '203.0.113.21')).status).toBe(401); // a genuinely different client is unaffected
  });
});
