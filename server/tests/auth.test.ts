import bcrypt from 'bcrypt';
import type { Express } from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { createApp } from '../src/app';
import { DEV_JWT_SECRET, parseConfig } from '../src/config';
import type { Pool } from '../src/db/pool';
import { FakeClock } from '../src/lib/clock';
import type { ErrorBody } from '../src/lib/errors';
import { issueToken, verifyToken } from '../src/services/tokenService';
import { createTestPool, resetData, testAuthSettings, testBilling } from './helpers';

const START = '2026-03-01T10:00:00Z';
const SECRET = testAuthSettings().tokens.secret;
const PASSWORD = 'correct horse battery';

let pool: Pool;
let clock: FakeClock;
let app: Express;

const makeApp = (opts: Parameters<typeof testAuthSettings>[0] = {}, p: Pool = pool, c = clock) =>
  createApp({ pool: p, clock: c, corsOrigins: [], auth: testAuthSettings(opts), billing: testBilling() });

interface AuthBody {
  user: { id: string; email: string; name: string; createdAt: string };
  token: string;
  expiresAt: string;
}

async function register(email = 'alice@example.com', password = PASSWORD, name = 'Alice', a: Express = app) {
  return request(a).post('/auth/register').send({ email, password, name });
}
async function registered(email = 'alice@example.com') {
  const res = await register(email);
  expect(res.status).toBe(201);
  return res.body as AuthBody;
}
const errorOf = (res: request.Response) => (res.body as ErrorBody).error;

beforeAll(() => {
  pool = createTestPool();
});
beforeEach(async () => {
  await resetData(pool);
  clock = new FakeClock(START);
  app = makeApp();
});
afterAll(async () => {
  await pool.end();
});

describe('POST /auth/register', () => {
  it('creates a user, normalizes the email, hashes the password with bcrypt and returns a usable token', async () => {
    const res = await register('  Alice@Example.COM ', PASSWORD, '  Alice  ');
    expect(res.status).toBe(201);
    const body = res.body as AuthBody;
    expect(body.user).toMatchObject({ email: 'alice@example.com', name: 'Alice' });
    expect(body.user.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.expiresAt).toBe('2026-03-01T11:00:00.000Z');
    expect(JSON.stringify(res.body)).not.toMatch(/password|hash/i);

    const { rows } = await pool.query<{ email: string; password_hash: string }>('SELECT email, password_hash FROM users');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.email).toBe('alice@example.com');
    expect(rows[0]!.password_hash).toMatch(/^\$2[aby]\$04\$/); // bcrypt, test cost
    expect(rows[0]!.password_hash).not.toContain(PASSWORD);
    expect(await bcrypt.compare(PASSWORD, rows[0]!.password_hash)).toBe(true);

    const me = await request(app).get('/auth/me').set('Authorization', `Bearer ${body.token}`);
    expect(me.status).toBe(200);
  });

  it('salts: the same password yields different hashes for different users', async () => {
    await register('a@example.com');
    await register('b@example.com');
    const { rows } = await pool.query<{ password_hash: string }>('SELECT password_hash FROM users');
    expect(rows[0]!.password_hash).not.toBe(rows[1]!.password_hash);
  });

  it('rejects a duplicate email, including different case and whitespace, with 409 EMAIL_TAKEN', async () => {
    await registered('alice@example.com');
    for (const dup of ['alice@example.com', 'ALICE@example.com', '  Alice@Example.Com  ']) {
      const res = await register(dup);
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: { code: 'EMAIL_TAKEN', message: 'An account with this email already exists', details: {} } });
    }
    expect((await pool.query('SELECT 1 FROM users')).rowCount).toBe(1);
  });

  it('creates exactly one user when the same email registers concurrently', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => register('race@example.com')));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);
    expect((await pool.query('SELECT 1 FROM users')).rowCount).toBe(1);
  });

  it.each([
    ['missing body fields', {}, ['email', 'password', 'name']],
    ['invalid email', { email: 'not-an-email', password: PASSWORD, name: 'A' }, ['email']],
    ['empty email', { email: '   ', password: PASSWORD, name: 'A' }, ['email']],
    ['overlong email', { email: `${'a'.repeat(250)}@example.com`, password: PASSWORD, name: 'A' }, ['email']],
    ['password too short (7)', { email: 'a@example.com', password: '1234567', name: 'A' }, ['password']],
    ['password over 72 bytes (73 ASCII)', { email: 'a@example.com', password: 'a'.repeat(73), name: 'A' }, ['password']],
    ['password over 72 bytes (multi-byte, 100 bytes in 25 chars)', { email: 'a@example.com', password: '😀'.repeat(25), name: 'A' }, ['password']],
    ['blank name', { email: 'a@example.com', password: PASSWORD, name: '   ' }, ['name']],
    ['overlong name', { email: 'a@example.com', password: PASSWORD, name: 'n'.repeat(101) }, ['name']],
    ['wrong types', { email: 5, password: ['x'], name: {} }, ['email', 'password', 'name']],
    ['unknown extra field (mass assignment)', { email: 'a@example.com', password: PASSWORD, name: 'A', is_admin: true }, ['(body)']],
  ])('returns 400 VALIDATION_ERROR for %s', async (_label, payload, expectedPaths) => {
    const res = await request(app).post('/auth/register').send(payload);
    expect(res.status).toBe(400);
    const err = errorOf(res);
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.message).toBe('Invalid request');
    const fields = (err.details as { fields: { path: string; message: string }[] }).fields;
    for (const path of expectedPaths) expect(fields.map((f) => f.path)).toContain(path);
    expect(JSON.stringify(res.body)).not.toContain(PASSWORD);
    expect((await pool.query('SELECT 1 FROM users')).rowCount).toBe(0);
  });

  it('accepts a password of exactly 8 and exactly 72 bytes', async () => {
    expect((await register('a@example.com', '12345678')).status).toBe(201);
    expect((await register('b@example.com', 'a'.repeat(72))).status).toBe(201);
  });

  it('rejects a non-JSON / missing body as 400 in the standard shape', async () => {
    const res = await request(app).post('/auth/register').set('Content-Type', 'text/plain').send('hello');
    expect(res.status).toBe(400);
    expect(errorOf(res).code).toBe('VALIDATION_ERROR');
  });
});

describe('POST /auth/login', () => {
  beforeEach(async () => {
    await registered('alice@example.com');
  });
  const login = (email: string, password: string) => request(app).post('/auth/login').send({ email, password });

  it('logs in with correct credentials; email is case/whitespace-insensitive; token expires after the configured TTL', async () => {
    for (const email of ['alice@example.com', 'ALICE@EXAMPLE.COM', ' alice@example.com ']) {
      const res = await login(email, PASSWORD);
      expect(res.status).toBe(200);
      const body = res.body as AuthBody;
      expect(body.user.email).toBe('alice@example.com');
      expect(body.expiresAt).toBe('2026-03-01T11:00:00.000Z');
      expect(JSON.stringify(body)).not.toMatch(/password|hash/i);
      const decoded = jwt.decode(body.token) as Record<string, unknown>;
      expect(Object.keys(decoded).sort()).toEqual(['exp', 'iat', 'sub']); // no PII in the token
      expect((decoded.exp as number) - (decoded.iat as number)).toBe(3600);
      expect(decoded.sub).toBe(body.user.id);
    }
  });

  it('returns the identical generic 401 for a wrong password and an unknown email (no user enumeration)', async () => {
    const wrongPassword = await login('alice@example.com', 'wrong password!');
    const unknownEmail = await login('nobody@example.com', PASSWORD);
    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(wrongPassword.body).toEqual(unknownEmail.body);
    expect(wrongPassword.body).toEqual({ error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password', details: {} } });
  });

  it('does not let a truncated (over 72 bytes) password match', async () => {
    await register('long@example.com', 'a'.repeat(72));
    expect((await login('long@example.com', 'a'.repeat(72))).status).toBe(200);
    const res = await login('long@example.com', `${'a'.repeat(72)}EXTRA`);
    expect(res.status).toBe(401);
    expect(errorOf(res).code).toBe('INVALID_CREDENTIALS');
  });

  it('is case-sensitive for the password and supports unicode passwords', async () => {
    expect((await login('alice@example.com', PASSWORD.toUpperCase())).status).toBe(401);
    await register('uni@example.com', 'pässwörd-日本語');
    expect((await login('uni@example.com', 'pässwörd-日本語')).status).toBe(200);
  });

  it.each([
    ['empty body', {}],
    ['missing password', { email: 'alice@example.com' }],
    ['empty password', { email: 'alice@example.com', password: '' }],
    ['malformed email', { email: 'nope', password: PASSWORD }],
    ['extra field', { email: 'alice@example.com', password: PASSWORD, remember: true }],
  ])('returns 400 for %s', async (_l, payload) => {
    const res = await request(app).post('/auth/login').send(payload);
    expect(res.status).toBe(400);
    expect(errorOf(res).code).toBe('VALIDATION_ERROR');
  });

  it('does not accept a password in a GET query string (route is POST only)', async () => {
    const res = await request(app).get('/auth/login?email=alice@example.com&password=x');
    expect(res.status).toBe(404);
  });
});

describe('authentication middleware and GET /auth/me', () => {
  const me = (header?: string, a: Express = app) => {
    const r = request(a).get('/auth/me');
    return header === undefined ? r : r.set('Authorization', header);
  };
  const sign = (payload: object, secret = SECRET, options: jwt.SignOptions = { algorithm: 'HS256' }) => jwt.sign(payload, secret, options);
  const nowSec = () => Math.floor(clock.now().getTime() / 1000);

  it('returns the authenticated user (and never the password hash)', async () => {
    const { token, user } = await registered();
    const res = await me(`Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ user });
    expect(JSON.stringify(res.body)).not.toMatch(/password|hash/i);
  });

  it.each([
    ['no Authorization header', undefined],
    ['empty header', ''],
    ['wrong scheme', 'Basic YWxpY2U6cGFzcw=='],
    ['scheme only', 'Bearer'],
    ['garbage token', 'Bearer not.a.jwt'],
    ['two-part token', 'Bearer abc.def'],
    ['token with spaces/injection', 'Bearer a.b.c; DROP TABLE users'],
  ])('rejects %s with 401 UNAUTHENTICATED', async (_l, header) => {
    const res = await me(header);
    expect(res.status).toBe(401);
    expect(errorOf(res).code).toBe('UNAUTHENTICATED');
    expect(Object.keys(res.body as object)).toEqual(['error']);
  });

  it('accepts the token until the exact expiry instant, then returns 401 TOKEN_EXPIRED (fake clock)', async () => {
    const { token } = await registered();
    clock.advanceMs(3599 * 1000);
    expect((await me(`Bearer ${token}`)).status).toBe(200);
    clock.advanceMs(1000); // now == exp
    const expired = await me(`Bearer ${token}`);
    expect(expired.status).toBe(401);
    expect(errorOf(expired).code).toBe('TOKEN_EXPIRED');
    clock.advanceMs(86_400_000);
    expect((await me(`Bearer ${token}`)).status).toBe(401);
    // logging in again yields a fresh working token
    const fresh = await request(app).post('/auth/login').send({ email: 'alice@example.com', password: PASSWORD });
    expect((await me(`Bearer ${(fresh.body as AuthBody).token}`)).status).toBe(200);
  });

  it('honors a custom TTL', async () => {
    const short = makeApp({ ttlSeconds: 60 });
    const reg = await register('ttl@example.com', PASSWORD, 'T', short);
    const { token, expiresAt } = reg.body as AuthBody;
    expect(expiresAt).toBe('2026-03-01T10:01:00.000Z');
    clock.advanceMs(61_000);
    expect(errorOf(await me(`Bearer ${token}`, short)).code).toBe('TOKEN_EXPIRED');
  });

  it('rejects tampered, wrong-secret, wrong-algorithm and unsigned tokens', async () => {
    const { token, user } = await registered();
    const [h, p, s] = token.split('.') as [string, string, string];
    const forgedPayload = Buffer.from(JSON.stringify({ sub: user.id, iat: nowSec(), exp: nowSec() + 99_999 })).toString('base64url');
    const cases: Record<string, string> = {
      'tampered payload': `${h}.${forgedPayload}.${s}`,
      'tampered signature': `${h}.${p}.${s.slice(0, -2)}xx`,
      'wrong secret': sign({ sub: user.id, iat: nowSec(), exp: nowSec() + 3600 }, 'some-other-secret-some-other-secret-1'),
      'HS512 (algorithm pinned to HS256)': sign({ sub: user.id, iat: nowSec(), exp: nowSec() + 3600 }, SECRET, { algorithm: 'HS512' }),
      'alg=none': `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: user.id, exp: nowSec() + 3600 })).toString('base64url')}.`,
    };
    for (const [label, bad] of Object.entries(cases)) {
      const res = await me(`Bearer ${bad}`);
      expect(res.status, label).toBe(401);
      expect(errorOf(res).code, label).toBe('UNAUTHENTICATED');
    }
  });

  it('rejects tokens with a missing or non-UUID subject, and tokens without expiry still need a valid sub', async () => {
    for (const payload of [{ iat: nowSec(), exp: nowSec() + 3600 }, { sub: 'admin', iat: nowSec(), exp: nowSec() + 3600 }, { sub: 42, iat: nowSec(), exp: nowSec() + 3600 }]) {
      const res = await me(`Bearer ${sign(payload)}`);
      expect(res.status).toBe(401);
    }
  });

  it('rejects a valid token whose user no longer exists', async () => {
    const { token } = await registered();
    await pool.query('DELETE FROM users');
    const res = await me(`Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(errorOf(res).code).toBe('UNAUTHENTICATED');
  });

  it("scopes identity to the token: user B's token returns user B", async () => {
    const a = await registered('a@example.com');
    const b = await registered('b@example.com');
    expect(((await me(`Bearer ${a.token}`)).body as { user: { email: string } }).user.email).toBe('a@example.com');
    expect(((await me(`Bearer ${b.token}`)).body as { user: { email: string } }).user.email).toBe('b@example.com');
  });

  it('accepts a lower-case "bearer" scheme (RFC 7235 is case-insensitive)', async () => {
    const { token } = await registered();
    expect((await me(`bearer ${token}`)).status).toBe(200);
  });
});

describe('token service', () => {
  const settings = { secret: SECRET, ttlSeconds: 120 };
  const id = '11111111-1111-4111-8111-111111111111';

  it('issues and verifies tokens against the injected clock', () => {
    const c = new FakeClock(START);
    const { token, expiresAt } = issueToken(id, settings, c);
    expect(expiresAt.toISOString()).toBe('2026-03-01T10:02:00.000Z');
    expect(verifyToken(token, settings, c)).toEqual({ userId: id });
    c.advanceMs(119_000);
    expect(verifyToken(token, settings, c)).toEqual({ userId: id });
    c.advanceMs(1000);
    expect(() => verifyToken(token, settings, c)).toThrowError(expect.objectContaining({ status: 401, code: 'TOKEN_EXPIRED' }) as Error);
  });

  it('only exp governs validity: a token is still accepted by a clock slightly behind its iat', () => {
    const issuer = new FakeClock('2026-03-01T12:00:00Z');
    const { token } = issueToken(id, settings, issuer);
    const earlier = new FakeClock('2026-03-01T11:59:00Z');
    expect(verifyToken(token, settings, earlier)).toEqual({ userId: id });
  });
});

describe('database failures', () => {
  const secretLeak = 'connection terminated unexpectedly password=hunter2';
  let errorSpy: MockInstance<typeof console.error>;
  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    errorSpy.mockRestore();
  });
  const brokenPool = { query: () => Promise.reject(new Error(secretLeak)) } as unknown as Pool;

  it('register returns a generic 500 without leaking details; nothing is created', async () => {
    const res = await register('a@example.com', PASSWORD, 'A', makeApp({}, brokenPool));
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred', details: {} } });
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
  });

  it('login returns a generic 500 (not a misleading 401) when the database is down', async () => {
    const res = await request(makeApp({}, brokenPool)).post('/auth/login').send({ email: 'a@example.com', password: PASSWORD });
    expect(res.status).toBe(500);
    expect(errorOf(res).code).toBe('INTERNAL_ERROR');
  });

  it('a valid token with a failing user lookup yields 500, not 401 (clients must not log out on transient errors)', async () => {
    const { token } = issueToken('11111111-1111-4111-8111-111111111111', testAuthSettings().tokens, clock);
    const res = await request(makeApp({}, brokenPool)).get('/auth/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(500);
    expect(errorOf(res).code).toBe('INTERNAL_ERROR');
  });

  it('an email-unique violation is a 409, but any other database error is not mistaken for one', async () => {
    const otherViolation = Object.assign(new Error('null value in column'), { code: '23502', constraint: 'users_name_not_null' });
    const p = { query: () => Promise.reject(otherViolation) } as unknown as Pool;
    const res = await register('a@example.com', PASSWORD, 'A', makeApp({}, p));
    expect(res.status).toBe(500);
  });

  it('never logs passwords, tokens or hashes', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { token } = await registered('log@example.com');
    await request(app).post('/auth/login').send({ email: 'log@example.com', password: 'WRONG-PASSWORD-xyz' });
    await register('a@example.com', 'LEAKY-PASSWORD-123', 'A', makeApp({}, brokenPool));
    await request(makeApp({}, brokenPool)).get('/auth/me').set('Authorization', `Bearer ${token}`);
    const logged = JSON.stringify([...errorSpy.mock.calls, ...logSpy.mock.calls]);
    for (const needle of [PASSWORD, 'WRONG-PASSWORD-xyz', 'LEAKY-PASSWORD-123', token, '$2b$']) expect(logged).not.toContain(needle);
    logSpy.mockRestore();
  });
});

describe('rate limiting', () => {
  it('limits credential endpoints (login and register) per client with a standard 429 error, and leaves other routes alone', async () => {
    const limited = makeApp({ max: 3 });
    for (let i = 0; i < 3; i++) {
      const res = await request(limited).post('/auth/login').send({ email: 'x@example.com', password: 'whatever1' });
      expect(res.status).toBe(401);
    }
    const blocked = await request(limited).post('/auth/login').send({ email: 'x@example.com', password: 'whatever1' });
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ error: { code: 'RATE_LIMITED', message: 'Too many requests, please try again later', details: {} } });
    expect((await request(limited).post('/auth/register').send({})).status).toBe(429); // shared by login and register
    expect((await request(limited).get('/health')).status).toBe(200);
  });

  it('/auth/me is NOT subject to the strict credential limiter: the frontend calls it on every page load', async () => {
    const limited = makeApp({ max: 2 });
    const reg = await register('me-limit@example.com', PASSWORD, 'M', limited); // 1 of 2 credential requests
    const { token } = reg.body as AuthBody;
    await request(limited).post('/auth/login').send({ email: 'me-limit@example.com', password: PASSWORD }); // 2 of 2
    expect((await request(limited).post('/auth/login').send({ email: 'me-limit@example.com', password: PASSWORD })).status).toBe(429);
    for (let i = 0; i < 25; i++) {
      expect((await request(limited).get('/auth/me').set('Authorization', `Bearer ${token}`)).status).toBe(200);
    }
    expect((await request(limited).get('/auth/me')).status).toBe(401); // unauthenticated is still a plain 401, not a 429
  });
});

describe('config for authentication', () => {
  const base = { DATABASE_URL: 'postgres://x' };
  it('uses a dev secret outside production and low bcrypt cost in test', () => {
    expect(parseConfig({ ...base }).JWT_SECRET).toBe(DEV_JWT_SECRET);
    expect(parseConfig({ ...base, NODE_ENV: 'test' }).BCRYPT_COST).toBe(4);
    expect(parseConfig({ ...base }).BCRYPT_COST).toBe(12);
    expect(parseConfig({ ...base }).JWT_EXPIRES_IN_SECONDS).toBe(3600);
  });
  it('fails startup in production without a strong, non-default JWT_SECRET', () => {
    const prod = { ...base, NODE_ENV: 'production' };
    expect(() => parseConfig(prod)).toThrow(/JWT_SECRET/);
    expect(() => parseConfig({ ...prod, JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/);
    expect(() => parseConfig({ ...prod, JWT_SECRET: DEV_JWT_SECRET })).toThrow(/JWT_SECRET/);
    expect(parseConfig({ ...prod, JWT_SECRET: 'x'.repeat(40) }).JWT_SECRET).toBe('x'.repeat(40));
    expect(() => parseConfig({ ...prod, JWT_SECRET: 'x'.repeat(40), BCRYPT_COST: '8' })).toThrow(/BCRYPT_COST/);
  });
  it('does not echo the secret in error messages', () => {
    try {
      parseConfig({ ...base, NODE_ENV: 'production', JWT_SECRET: 'tooshort-secret' });
    } catch (e) {
      expect((e as Error).message).not.toContain('tooshort-secret');
    }
  });
});
