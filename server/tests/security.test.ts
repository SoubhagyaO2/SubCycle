/**
 * Security regression suite (docs/SECURITY.md). It is deliberately driven by the SOURCE: the route inventory is parsed from
 * app.ts and routes/*.ts, so adding a route without documenting it (docs/API.md) AND classifying it here fails CI.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { MockProvider } from '../src/billing/mockProvider';
import { parseConfig } from '../src/config';
import type { Pool } from '../src/db/pool';
import { FakeClock } from '../src/lib/clock';
import { purgeExpiredIdempotencyKeys, runJobCycle } from '../src/services/renewalService';
import { createTestPool, resetData, testAuthSettings } from './helpers';
import { api, count, createHarness, DAY, planIds, signup, T0, type Harness, type User } from './harness';
import { testDatabaseUrl } from './testEnv';

const root = path.resolve(__dirname, '../..');
const serverSrc = path.join(root, 'server/src');

// ---- the route inventory, parsed from the code ---------------------------------------------------------------------

function inventory(): string[] {
  const app = readFileSync(path.join(serverSrc, 'app.ts'), 'utf8');
  const prefixOf = new Map<string, string>(); // exported routes function -> mount prefix
  for (const m of app.matchAll(/app\.use\('(\/[a-z]+)',\s*(\w+)\(/g)) prefixOf.set(m[2]!, m[1]!);
  for (const m of app.matchAll(/app\.use\((\w+Routes)\(/g)) prefixOf.set(m[1]!, '');
  const routes: string[] = [];
  const seenFns = new Set<string>();
  for (const file of readdirSync(path.join(serverSrc, 'routes'))) {
    const src = readFileSync(path.join(serverSrc, 'routes', file), 'utf8');
    for (const part of src.split(/export function /).slice(1)) {
      const fn = /^(\w+)\(/.exec(part)![1]!;
      seenFns.add(fn);
      const prefix = prefixOf.get(fn);
      if (prefix === undefined) throw new Error(`routes function ${fn} is not mounted in app.ts (or the mount pattern changed)`);
      for (const r of part.matchAll(/router\.(get|post|delete|put|patch)\('([^']*)'/g)) {
        const p = r[2] === '/' ? prefix || '/' : `${prefix}${r[2]}`;
        routes.push(`${r[1]!.toUpperCase()} ${p}`);
      }
    }
  }
  for (const fn of prefixOf.keys()) expect(seenFns.has(fn), `app.ts mounts ${fn} but no such routes function was found`).toBe(true);
  return routes.sort();
}

function documentedRoutes(): string[] {
  const md = readFileSync(path.join(root, 'docs/API.md'), 'utf8');
  return [...md.matchAll(/^### (GET|POST|DELETE|PUT|PATCH) (\/\S*)/gm)].map((m) => `${m[1]} ${m[2]}`).sort();
}

type Access = 'public' | 'bearer' | 'dev';
/** Every route must be classified. A new route fails the inventory test until someone decides how it is protected. */
const ACCESS: Record<string, Access> = {
  'GET /health': 'public',
  'POST /auth/register': 'public',
  'POST /auth/login': 'public',
  'GET /auth/me': 'bearer',
  'GET /plans': 'public',
  'GET /invoices': 'bearer',
  'GET /subscriptions/current': 'bearer',
  'GET /subscriptions/history': 'bearer',
  'GET /subscriptions/upgrade-preview': 'bearer',
  'POST /subscriptions': 'bearer',
  'POST /subscriptions/upgrade': 'bearer',
  'POST /subscriptions/downgrade': 'bearer',
  'POST /subscriptions/pause': 'bearer',
  'POST /subscriptions/resume': 'bearer',
  'POST /subscriptions/cancel': 'bearer',
  'POST /subscriptions/reactivate': 'bearer',
  'DELETE /subscriptions/pending-change': 'bearer',
  'GET /usage': 'bearer',
  'GET /usage/history': 'bearer',
  'POST /usage': 'bearer',
  'POST /demo/generate-report': 'bearer',
  'GET /billing/operations': 'bearer',
  'POST /dev/run-renewals': 'dev',
  'POST /dev/advance-clock': 'dev',
};

let pool: Pool;
let h: Harness;
let ids: Record<string, string>;
let alice: User;
let bob: User;

beforeAll(() => {
  pool = createTestPool();
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await resetData(pool);
  h = createHarness(pool, { dev: true });
  ids = await planIds(pool);
  alice = await signup(h, 'alice@example.com');
  bob = await signup(h, 'bob@example.com');
});

const callRoute = (app: Harness['app'], route: string, headers: Record<string, string> = {}, body?: object) => {
  const [m, p] = route.split(' ') as [string, string];
  const r = request(app)[m.toLowerCase() as 'get' | 'post' | 'delete'](p);
  for (const [k, v] of Object.entries(headers)) r.set(k, v);
  return body === undefined ? r : r.send(body);
};
const isErrorShape = (b: unknown): boolean => {
  const e = (b as { error?: { code?: unknown; message?: unknown; details?: unknown } })?.error;
  return typeof e?.code === 'string' && typeof e.message === 'string' && typeof e.details === 'object' && e.details !== null;
};

describe('route inventory: code, documentation and security classification agree', () => {
  it('every route in the source is documented in docs/API.md, and every documented route exists', () => {
    expect(documentedRoutes()).toEqual(inventory());
  });

  it('every route is classified here (a new route must be classified before CI passes)', () => {
    expect(Object.keys(ACCESS).sort()).toEqual(inventory());
  });

  it('only health, register, login and plans are public; dev routes are the only dev routes', () => {
    const pub = Object.entries(ACCESS).filter(([, a]) => a === 'public').map(([r]) => r).sort();
    expect(pub).toEqual(['GET /health', 'GET /plans', 'POST /auth/login', 'POST /auth/register']);
    expect(Object.entries(ACCESS).filter(([, a]) => a === 'dev').map(([r]) => r).sort()).toEqual(['POST /dev/advance-clock', 'POST /dev/run-renewals']);
  });
});

describe('authentication is required on every non-public route', () => {
  const protectedRoutes = Object.entries(ACCESS).filter(([, a]) => a !== 'public').map(([r]) => r);

  it.each(protectedRoutes)('%s: 401 without a token, in the standard error shape, never cached', async (route) => {
    const res = await callRoute(h.app, route);
    expect(res.status).toBe(401);
    expect(isErrorShape(res.body)).toBe(true);
    expect((res.body as { error: { code: string } }).error.code).toBe('UNAUTHENTICATED');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('every bad-token variant is rejected on every protected route (alg none, HS512, wrong secret, expired, tampered, junk)', async () => {
    const secret = testAuthSettings().tokens.secret;
    const now = Math.floor(h.clock.now().getTime() / 1000);
    const claims = { sub: alice.userId, iat: now, exp: now + 3600 };
    const good = jwt.sign(claims, secret, { algorithm: 'HS256' });
    const [hd, pl, sg] = good.split('.') as [string, string, string];
    const bad: Record<string, string> = {
      'alg none': `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${pl}.`,
      HS512: jwt.sign(claims, secret, { algorithm: 'HS512' }),
      'wrong secret': jwt.sign(claims, 'another-secret-another-secret-another-1', { algorithm: 'HS256' }),
      expired: jwt.sign({ ...claims, iat: now - 7200, exp: now - 3600 }, secret, { algorithm: 'HS256' }),
      'tampered payload': `${hd}.${Buffer.from(JSON.stringify({ ...claims, sub: bob.userId })).toString('base64url')}.${sg}`,
      'tampered signature': `${hd}.${pl}.${sg.slice(0, -3)}AAA`,
      junk: 'not-a-jwt',
      'sub not a uuid': jwt.sign({ ...claims, sub: 'admin' }, secret, { algorithm: 'HS256' }),
    };
    for (const route of protectedRoutes.filter((r) => ACCESS[r] === 'bearer')) {
      for (const [label, token] of Object.entries(bad)) {
        const res = await callRoute(h.app, route, { Authorization: `Bearer ${token}` });
        expect(res.status, `${route} with ${label}`).toBe(401);
        expect(isErrorShape(res.body)).toBe(true);
      }
    }
  });

  it('the token is only accepted from the Authorization header (not a query string, cookie or body); oversized headers are a clean 401', async () => {
    expect((await request(h.app).get(`/subscriptions/current?token=${alice.token}`)).status).toBe(401);
    expect((await request(h.app).get('/subscriptions/current').set('Cookie', `token=${alice.token}`)).status).toBe(401);
    expect((await request(h.app).post('/subscriptions/pause').send({ token: alice.token })).status).toBe(401);
    expect((await request(h.app).get('/subscriptions/current').set('Authorization', `Bearer ${'a'.repeat(8000)}.b.c`)).status).toBe(401);
    expect((await request(h.app).get('/subscriptions/current').set('Authorization', `Basic ${Buffer.from('a:b').toString('base64')}`)).status).toBe(401);
  });

  it('a token for a user who no longer exists is rejected', async () => {
    await pool.query('DELETE FROM users WHERE id = $1', [bob.userId]);
    expect((await api(h, bob).get('/subscriptions/current')).status).toBe(401);
  });
});

describe('user isolation: one user can neither read nor change another user\'s data', () => {
  async function snapshotOf(userId: string): Promise<string> {
    const q = async (sql: string) => JSON.stringify((await pool.query(sql, [userId])).rows);
    return [
      await q('SELECT * FROM subscriptions WHERE user_id = $1 ORDER BY id'),
      await q('SELECT i.* FROM invoices i JOIN subscriptions s ON s.id = i.subscription_id WHERE s.user_id = $1 ORDER BY i.id'),
      await q('SELECT * FROM billing_operations WHERE user_id = $1 ORDER BY id'),
      await q('SELECT e.* FROM subscription_events e JOIN subscriptions s ON s.id = e.subscription_id WHERE s.user_id = $1 ORDER BY e.id'),
      await q('SELECT r.* FROM usage_records r JOIN subscriptions s ON s.id = r.subscription_id WHERE s.user_id = $1 ORDER BY r.id'),
      await q('SELECT u.* FROM usage_events u JOIN subscriptions s ON s.id = u.subscription_id WHERE s.user_id = $1 ORDER BY u.id'),
      await q('SELECT * FROM demo_reports WHERE user_id = $1 ORDER BY id'),
    ].join('\n');
  }

  async function alicesWorld() {
    const a = api(h, alice);
    expect((await a.post('/subscriptions', { planId: ids.business_monthly }, { 'Idempotency-Key': 'shared-key' })).status).toBe(201);
    expect((await a.post('/subscriptions/downgrade', { planId: ids.pro_monthly })).status).toBe(200);
    expect((await a.post('/usage', { metric: 'api_calls', quantity: 7 })).status).toBe(201);
    expect((await a.post('/demo/generate-report')).status).toBe(201);
    h.clock.advanceMs(DAY);
    const subscription = ((await a.get('/subscriptions/current')).body as { subscription: { id: string } }).subscription.id;
    const invoice = ((await a.get('/invoices')).body as { invoices: { id: string }[] }).invoices[0]!.id;
    const operation = ((await a.get('/billing/operations')).body as { operations: { id: string }[] }).operations[0]!.id;
    const report = (await pool.query<{ id: string }>('SELECT id FROM demo_reports WHERE user_id = $1', [alice.userId])).rows[0]!.id;
    return { subscription, invoice, operation, report, email: 'alice@example.com' };
  }

  it("B's reads never contain A's identifiers or data, on every GET route", async () => {
    const secrets = await alicesWorld();
    await api(h, bob).post('/subscriptions', { planId: ids.free });
    const b = api(h, bob);
    for (const route of Object.keys(ACCESS).filter((r) => r.startsWith('GET ') && ACCESS[r] === 'bearer')) {
      const path = route.slice(4) + (route.includes('upgrade-preview') ? `?planId=${ids.pro_monthly}` : '');
      const res = await b.get(path);
      const text = JSON.stringify(res.body);
      for (const [what, value] of Object.entries(secrets)) expect(text, `${route} leaked A's ${what}`).not.toContain(value);
      expect(text).not.toContain(alice.userId);
    }
    expect(((await b.get('/usage')).body as { usage: { metric: string; used: number }[] }).usage.find((m) => m.metric === 'api_calls')!.used).toBe(0);
  });

  it("B's mutations (every lifecycle and usage route) never change A's rows", async () => {
    await alicesWorld();
    const before = await snapshotOf(alice.userId);
    const b = api(h, bob);
    await b.post('/subscriptions', { planId: ids.pro_monthly }); // B subscribes (paid) so every action has something to act on
    for (const [route, body] of [
      ['/subscriptions/upgrade', { planId: ids.business_monthly }],
      ['/subscriptions/downgrade', { planId: ids.free }],
      ['/subscriptions/pause', undefined],
      ['/subscriptions/resume', undefined],
      ['/subscriptions/cancel', undefined],
      ['/subscriptions/reactivate', undefined],
      ['/usage', { metric: 'api_calls', quantity: 3 }],
      ['/demo/generate-report', undefined],
    ] as const) {
      await b.post(route, body);
    }
    await b.del('/subscriptions/pending-change');
    expect(await snapshotOf(alice.userId)).toBe(before);
    expect(((await api(h, alice).get('/subscriptions/current')).body as { subscription: { status: string } }).subscription.status).toBe('active');
  });

  it('lifecycle routes are keyed by the TOKEN: ids sent in the body are rejected, so another user cannot be targeted', async () => {
    const secrets = await alicesWorld();
    const b = api(h, bob);
    for (const route of ['/subscriptions', '/subscriptions/upgrade', '/subscriptions/downgrade']) {
      const res = await b.post(route, { planId: ids.pro_monthly, subscriptionId: secrets.subscription, userId: alice.userId });
      expect(res.status, route).toBe(400);
    }
    for (const route of ['/subscriptions/pause', '/subscriptions/resume', '/subscriptions/cancel', '/subscriptions/reactivate']) {
      expect((await b.post(route, { subscriptionId: secrets.subscription })).status, route).toBe(400);
    }
    expect((await b.post('/usage', { metric: 'api_calls', quantity: 1, subscriptionId: secrets.subscription })).status).toBe(400);
  });

  it('idempotency keys are per user: B reusing A\'s key neither replays A\'s response nor collides', async () => {
    const aliceResponse = await api(h, alice).post('/subscriptions', { planId: ids.free }, { 'Idempotency-Key': 'common-key' });
    const bobResponse = await api(h, bob).post('/subscriptions', { planId: ids.free }, { 'Idempotency-Key': 'common-key' });
    expect(aliceResponse.status).toBe(201);
    expect(bobResponse.status).toBe(201);
    expect(bobResponse.headers['idempotent-replay']).toBeUndefined();
    expect((bobResponse.body as { subscription: { id: string } }).subscription.id).not.toBe((aliceResponse.body as { subscription: { id: string } }).subscription.id);
    // and B replaying its own key gets B's response, not A's
    const again = await api(h, bob).post('/subscriptions', { planId: ids.free }, { 'Idempotency-Key': 'common-key' });
    expect(again.headers['idempotent-replay']).toBe('true');
    expect(again.body).toEqual(bobResponse.body);
    expect(await count(pool, 'SELECT 1 FROM idempotency_keys')).toBe(2);
  });
});

describe('request validation', () => {
  const bodyRoutes: [string, object][] = [
    ['POST /auth/register', { email: 'x@example.com', password: 'correct horse battery', name: 'X' }],
    ['POST /auth/login', { email: 'alice@example.com', password: 'whatever1' }],
    ['POST /subscriptions', { planId: '11111111-1111-4111-8111-111111111111' }],
    ['POST /subscriptions/upgrade', { planId: '11111111-1111-4111-8111-111111111111' }],
    ['POST /subscriptions/downgrade', { planId: '11111111-1111-4111-8111-111111111111' }],
    ['POST /subscriptions/cancel', {}],
    ['POST /subscriptions/pause', {}],
    ['POST /subscriptions/resume', {}],
    ['POST /subscriptions/reactivate', {}],
    ['POST /usage', { metric: 'api_calls', quantity: 1 }],
  ];

  it.each(bodyRoutes)('%s rejects unknown fields (mass assignment) and mistyped input with 400', async (route, valid) => {
    const auth = { Authorization: `Bearer ${alice.token}` };
    const extra = await callRoute(h.app, route, auth, { ...valid, isAdmin: true });
    expect(extra.status).toBe(400);
    expect(isErrorShape(extra.body)).toBe(true);
    const proto = await callRoute(h.app, route, auth, JSON.parse('{"__proto__":{"isAdmin":true},"constructor":{"prototype":{"x":1}}}') as object);
    expect(proto.status).toBe(400);
    expect(({} as { isAdmin?: boolean }).isAdmin).toBeUndefined(); // prototype untouched
    const wrong = await callRoute(h.app, route, auth, { planId: 5, email: 5, password: [], name: {}, metric: 5, quantity: '5', immediate: 'yes' });
    expect(wrong.status).toBe(400);
    const array = await callRoute(h.app, route, auth, []);
    expect(array.status).toBe(400);
  });

  it('query parameters are validated (uuid, no arrays)', async () => {
    const a = api(h, alice);
    await a.post('/subscriptions', { planId: ids.free });
    for (const q of ['', '?planId=not-a-uuid', `?planId[]=${ids.pro_monthly}`, `?planId=${ids.pro_monthly}&planId=${ids.business_monthly}`, '?planId=%00']) {
      const res = await a.get(`/subscriptions/upgrade-preview${q}`);
      expect(res.status, q).toBe(400);
      expect(isErrorShape(res.body)).toBe(true);
    }
  });

  it('malformed JSON, wrong content types and oversized bodies are clean 4xx errors in the standard shape', async () => {
    const auth = { Authorization: `Bearer ${alice.token}` };
    const malformed = await request(h.app).post('/usage').set(auth).set('Content-Type', 'application/json').send('{"metric":');
    expect(malformed.status).toBe(400);
    expect(isErrorShape(malformed.body)).toBe(true);
    const text = await request(h.app).post('/usage').set(auth).set('Content-Type', 'text/plain').send('metric=api_calls');
    expect(text.status).toBe(400);
    const huge = await request(h.app).post('/usage').set(auth).set('Content-Type', 'application/json').send(JSON.stringify({ metric: 'a'.repeat(200_000) }));
    expect(huge.status).toBe(413);
    expect((huge.body as { error: { code: string } }).error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('SQL metacharacters in inputs are treated as data (parameterized queries)', async () => {
    const evil = "x'; DROP TABLE users; --";
    expect((await request(h.app).post('/auth/login').send({ email: `${evil}@example.com`, password: evil })).status).toBe(400);
    expect((await request(h.app).post('/auth/login').send({ email: 'alice@example.com', password: evil })).status).toBe(401);
    expect((await api(h, alice).post('/usage', { metric: evil, quantity: 1 })).status).toBe(400);
    expect((await api(h, alice).post('/subscriptions/pause', undefined, { 'Idempotency-Key': evil })).status).toBe(400);
    expect(await count(pool, 'SELECT 1 FROM users')).toBe(2);
    const reg = await request(h.app).post('/auth/register').send({ email: "o'brien+x@example.com", password: 'correct horse battery', name: evil });
    expect(reg.status).toBe(201);
    expect((reg.body as { user: { name: string } }).user.name).toBe(evil); // stored verbatim, returned as data
  });
});

describe('CORS', () => {
  const app = () => createHarness(pool, { corsOrigins: ['http://allowed.test'] }).app;

  it('answers an allow-listed origin and nobody else; never allows credentials', async () => {
    const a = app();
    const ok = await request(a).get('/plans').set('Origin', 'http://allowed.test');
    expect(ok.headers['access-control-allow-origin']).toBe('http://allowed.test');
    expect(ok.headers['access-control-allow-credentials']).toBeUndefined();
    expect(ok.headers['access-control-allow-origin']).not.toBe('*');
    const other = await request(a).get('/plans').set('Origin', 'http://evil.test');
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
    expect((await request(a).get('/plans').set('Origin', 'null')).headers['access-control-allow-origin']).toBeUndefined();
  });

  it('preflight allows exactly the needed methods and headers for the allow-listed origin only', async () => {
    const a = app();
    const pre = await request(a)
      .options('/subscriptions/upgrade')
      .set('Origin', 'http://allowed.test')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'authorization,content-type,idempotency-key');
    expect(pre.headers['access-control-allow-origin']).toBe('http://allowed.test');
    expect(pre.headers['access-control-allow-methods']).toBe('GET,POST,DELETE,OPTIONS');
    expect(pre.headers['access-control-allow-headers']?.toLowerCase()).toContain('idempotency-key');
    const evil = await request(a).options('/subscriptions/upgrade').set('Origin', 'http://evil.test').set('Access-Control-Request-Method', 'POST');
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('exposes the idempotency replay header to allow-listed browsers', async () => {
    const res = await request(app()).get('/plans').set('Origin', 'http://allowed.test');
    expect(res.headers['access-control-expose-headers']).toContain('Idempotent-Replay');
  });
});

describe('response headers and error safety', () => {
  it('sets security headers, hides the framework, and forbids caching on every response', async () => {
    for (const res of [await request(h.app).get('/plans'), await request(h.app).get('/health'), await api(h, alice).get('/auth/me'), await request(h.app).get('/missing')]) {
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBeDefined();
      expect(res.headers['x-powered-by']).toBeUndefined();
      expect(res.headers['cache-control']).toBe('no-store');
    }
  });

  it('every error response has the standard shape, with no stack traces, SQL or internals, even when the database fails', async () => {
    const leak = 'SELECT password_hash FROM users WHERE secret = hunter2 at /srv/app/db.ts:42';
    const failing = new Proxy(pool, {
      get(target, prop) {
        if (prop === 'query') {
          return (sql: unknown, ...args: unknown[]) => (typeof sql === 'string' && sql.includes('FROM users WHERE id') ? target.query(sql, ...(args as [unknown[]])) : Promise.reject(new Error(leak)));
        }
        if (prop === 'connect') return () => Promise.reject(new Error(leak));
        const v = (target as unknown as Record<string | symbol, unknown>)[prop];
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const app = createApp({ pool: failing, clock: new FakeClock(T0), corsOrigins: [], auth: testAuthSettings({ ttlSeconds: 10 * 365 * 86_400 }), billing: { provider: new MockProvider(), providerTimeoutMs: 1000 } });
    const originalError = console.error;
    console.error = () => undefined; // the server logs the failure (message only); keep the test output clean
    try {
      // GET /auth/me only reads the user row (allowed through by the proxy above), so it correctly still succeeds.
      for (const route of Object.keys(ACCESS).filter((r) => ACCESS[r] === 'bearer' && r !== 'GET /auth/me')) {
        const body = route.startsWith('POST ') ? (route.includes('/usage') ? { metric: 'api_calls', quantity: 1 } : route.includes('upgrade') || route.includes('downgrade') || route === 'POST /subscriptions' ? { planId: ids.pro_monthly } : undefined) : undefined;
        const res = await callRoute(app, route + (route.includes('upgrade-preview') ? `?planId=${ids.pro_monthly}` : ''), { Authorization: `Bearer ${alice.token}` }, body);
        expect(res.status, route).toBe(500);
        expect(res.body, route).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred', details: {} } });
        expect(JSON.stringify(res.body)).not.toMatch(/SELECT|hunter2|password_hash|\.ts:|at \/|stack/i);
      }
    } finally {
      console.error = originalError;
    }
  });

  it('login errors never reveal whether an email exists, and never echo secrets', async () => {
    const a = await request(h.app).post('/auth/login').send({ email: 'alice@example.com', password: 'wrong password!' });
    const b = await request(h.app).post('/auth/login').send({ email: 'nobody@example.com', password: 'wrong password!' });
    expect(a.status).toBe(401);
    expect(a.body).toEqual(b.body);
    expect(JSON.stringify(a.body)).not.toContain('wrong password!');
  });
});

describe('rate limiting', () => {
  it('login/register share a strict per-IP limiter; /auth/me and usage are per user, so one user cannot exhaust another\'s allowance', async () => {
    const limited = createHarness(pool, { authMax: 2 });
    const u1 = await signup(limited, 'one@example.com'); // 1 credential request
    await request(limited.app).post('/auth/login').send({ email: 'one@example.com', password: 'wrong-password' }); // 2
    expect((await request(limited.app).post('/auth/login').send({ email: 'one@example.com', password: 'wrong-password' })).status).toBe(429);
    for (let i = 0; i < 10; i++) expect((await api(limited, u1).get('/auth/me')).status).toBe(200); // not in the strict bucket
    expect((await request(limited.app).get('/plans')).status).toBe(200);
  });

  it('the per-user usage limiter is keyed by user, not shared', async () => {
    const limited = createHarness(pool, { usageMax: 2 });
    const u1 = await signup(limited, 'p1@example.com');
    const u2 = await signup(limited, 'p2@example.com');
    for (const u of [u1, u2]) await api(limited, u).post('/subscriptions', { planId: ids.free });
    await api(limited, u1).get('/usage');
    await api(limited, u1).get('/usage');
    expect((await api(limited, u1).get('/usage')).status).toBe(429);
    expect((await api(limited, u2).get('/usage')).status).toBe(200);
  });
});

describe('development routes can never be enabled in production', () => {
  const baseEnv = { DATABASE_URL: 'postgres://x', NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(40), CORS_ORIGINS: 'https://app.example.com' };

  it('config forces dev endpoints off, rejects the fake clock, and requires an explicit CORS allow-list in production', () => {
    expect(parseConfig({ ...baseEnv, ENABLE_DEV_ENDPOINTS: 'true' }).DEV_ENDPOINTS).toBe(false);
    expect(() => parseConfig({ ...baseEnv, FAKE_CLOCK: 'true' })).toThrow(/FAKE_CLOCK/);
    const { CORS_ORIGINS, ...withoutCors } = baseEnv;
    void CORS_ORIGINS;
    expect(() => parseConfig(withoutCors)).toThrow(/CORS_ORIGINS/);
    expect(parseConfig({ ...withoutCors, NODE_ENV: 'development' }).CORS_ORIGINS).toEqual(['http://localhost:5173']); // the default is for development only
  });

  it('createApp refuses to mount /dev routes when NODE_ENV=production, whatever the caller passes', () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => createHarness(pool, { dev: true })).toThrow(/Refusing to mount \/dev/);
      expect(() => createHarness(pool)).not.toThrow(); // without dev routes the same app is fine
    } finally {
      process.env.NODE_ENV = previous;
    }
  });

  it('without the dev option the routes simply do not exist (404), even for an authenticated user', async () => {
    const plain = createHarness(pool);
    const user = await signup(plain, 'plain@example.com');
    expect((await api(plain, user).post('/dev/run-renewals')).status).toBe(404);
    expect((await api(plain, user).post('/dev/advance-clock', { days: 400 })).status).toBe(404);
  });

  describe('a real server process started with NODE_ENV=production', () => {
    let child: ChildProcess | undefined;
    const port = 4795;
    const env = (extra: Record<string, string> = {}) => ({
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      DATABASE_URL: testDatabaseUrl(),
      JWT_SECRET: 'p'.repeat(48),
      CORS_ORIGINS: 'https://app.example.com',
      ENABLE_DEV_ENDPOINTS: 'true', // an operator mistake: must still not mount anything
      RUN_JOBS: 'false',
      ...extra,
    });
    const tsx = path.join(root, 'node_modules/tsx/dist/cli.mjs');
    afterAll(() => {
      child?.kill();
    });

    it('does not serve /dev/* even when ENABLE_DEV_ENDPOINTS=true, and still serves the API', async () => {
      child = spawn(process.execPath, [tsx, 'src/server.ts'], { cwd: path.join(root, 'server'), env: env() });
      let up = false;
      for (let i = 0; i < 150 && !up; i++) {
        try {
          up = (await fetch(`http://127.0.0.1:${port}/health`)).ok;
        } catch {
          await new Promise((r) => setTimeout(r, 200));
        }
      }
      expect(up).toBe(true);
      const post = (p: string) => fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"days":365}' });
      expect((await post('/dev/run-renewals')).status).toBe(404);
      expect((await post('/dev/advance-clock')).status).toBe(404);
      expect((await fetch(`http://127.0.0.1:${port}/plans`)).status).toBe(200);
      child.kill();
    }, 60_000);

    it('refuses to start with FAKE_CLOCK=true, with a weak JWT secret, or without CORS_ORIGINS', async () => {
      const exitCode = (extra: Record<string, string>, drop: string[] = []) =>
        new Promise<number | null>((resolve) => {
          const e = env(extra) as Record<string, string | undefined>;
          for (const k of drop) delete e[k];
          const p = spawn(process.execPath, [tsx, 'src/server.ts'], { cwd: path.join(root, 'server'), env: e });
          const timer = setTimeout(() => {
            p.kill();
            resolve(null); // it started: that is the failure
          }, 20_000);
          p.on('exit', (code) => {
            clearTimeout(timer);
            resolve(code);
          });
        });
      expect(await exitCode({ FAKE_CLOCK: 'true' })).not.toBe(null);
      expect(await exitCode({ FAKE_CLOCK: 'true' })).not.toBe(0);
      expect(await exitCode({ JWT_SECRET: 'short' })).not.toBe(0);
      expect(await exitCode({}, ['CORS_ORIGINS'])).not.toBe(0);
    }, 90_000);
  });
});

describe('housekeeping: expired idempotency records are purged', () => {
  it('deletes only expired HTTP idempotency keys, as part of every job cycle', async () => {
    await api(h, alice).post('/subscriptions', { planId: ids.free }, { 'Idempotency-Key': 'fresh-key' });
    await pool.query(
      `INSERT INTO idempotency_keys (user_id, key, request_method, request_path, request_hash, status, locked_until, expires_at, response_status, response_body)
       VALUES ($1, 'stale-1', 'POST', '/x', 'h', 'completed', $2, $2, 200, '{}'::jsonb), ($1, 'stale-2', 'POST', '/x', 'h', 'completed', $2, $2, 200, '{}'::jsonb)`,
      [alice.userId, new Date(h.clock.now().getTime() - 1000)],
    );
    expect(await count(pool, 'SELECT 1 FROM idempotency_keys')).toBe(3);
    expect(await purgeExpiredIdempotencyKeys(h.deps)).toBe(2);
    expect(await count(pool, 'SELECT 1 FROM idempotency_keys')).toBe(1);

    h.clock.advanceMs(2 * DAY); // the remaining key expires too
    const cycle = await runJobCycle(h.deps, { reconcileAfterMs: 300_000 });
    expect(cycle.purgedIdempotencyKeys).toBe(1);
    expect(await count(pool, 'SELECT 1 FROM idempotency_keys')).toBe(0);
  });
});
