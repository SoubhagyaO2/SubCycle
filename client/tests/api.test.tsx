import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError } from '../src/api/client';
import { IntentKeys, newIdempotencyKey } from '../src/api/idempotency';
import { useIntentRunner } from '../src/hooks/useIntentRunner';
import { API, MockApi, deferred, err } from './mockApi';

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeClient(token: string | null = 'tok') {
  const unauthorized: string[] = [];
  const client = new ApiClient({ baseUrl: API, getToken: () => token, onUnauthorized: (r) => unauthorized.push(r) });
  return { client, unauthorized };
}

describe('ApiClient', () => {
  it('sends the bearer token, JSON body and Idempotency-Key, and returns the parsed body', async () => {
    const api = new MockApi().on('POST /subscriptions/upgrade', { body: { ok: true } });
    api.install();
    const { client } = makeClient('abc');
    const out = await client.request('POST', '/subscriptions/upgrade', { body: { planId: 'p' }, idempotencyKey: 'key-1' });
    expect(out).toEqual({ ok: true });
    expect(api.calls[0]).toMatchObject({
      method: 'POST',
      path: '/subscriptions/upgrade',
      body: { planId: 'p' },
      headers: { authorization: 'Bearer abc', 'idempotency-key': 'key-1', 'content-type': 'application/json' },
    });
  });

  it('omits Authorization for unauthenticated calls and when there is no token', async () => {
    const api = new MockApi().on('POST /auth/login', { body: {} }).on('GET /plans', { body: {} });
    api.install();
    const { client } = makeClient('abc');
    await client.request('POST', '/auth/login', { body: {}, auth: false });
    expect(api.calls[0]!.headers.authorization).toBeUndefined();
    const anon = makeClient(null).client;
    await anon.request('GET', '/plans');
    expect(api.calls[1]!.headers.authorization).toBeUndefined();
  });

  it('turns the standard error shape into an ApiError with code, status, message and details', async () => {
    new MockApi().on('GET /x', err(409, 'INVALID_TRANSITION', 'Cannot pause', { reason: 'cannot_pause_from_paused' })).install();
    const { client } = makeClient();
    const e = await client.request('GET', '/x').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ status: 409, code: 'INVALID_TRANSITION', message: 'Cannot pause', details: { reason: 'cannot_pause_from_paused' } });
  });

  it('copes with non-JSON and empty error bodies without crashing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Bad gateway</html>', { status: 502 })));
    const { client } = makeClient();
    const e = (await client.request('GET', '/x').catch((x: unknown) => x)) as ApiError;
    expect(e).toMatchObject({ status: 502, code: 'HTTP_502' });
    expect(e.message).toMatch(/something went wrong/i);
    expect(e.outcomeUnknown).toBe(true);
  });

  it('maps a network failure to NETWORK_ERROR (outcome unknown)', async () => {
    new MockApi().on('GET /x', { networkError: true }).install();
    const e = (await makeClient().client.request('GET', '/x').catch((x: unknown) => x)) as ApiError;
    expect(e).toMatchObject({ status: 0, code: 'NETWORK_ERROR' });
    expect(e.isNetwork).toBe(true);
    expect(e.outcomeUnknown).toBe(true);
  });

  it('401 on an authenticated request ends the session (expired vs invalid); login failures do not', async () => {
    new MockApi()
      .on('GET /a', err(401, 'TOKEN_EXPIRED', 'Token has expired'))
      .on('GET /b', err(401, 'UNAUTHENTICATED', 'Authentication required'))
      .on('POST /auth/login', err(401, 'INVALID_CREDENTIALS', 'Invalid email or password'))
      .install();
    const { client, unauthorized } = makeClient();
    await client.request('GET', '/a').catch(() => undefined);
    await client.request('GET', '/b').catch(() => undefined);
    await client.request('POST', '/auth/login', { body: {}, auth: false }).catch(() => undefined);
    expect(unauthorized).toEqual(['expired', 'invalid']);
    const noToken = makeClient(null);
    await noToken.client.request('GET', '/a').catch(() => undefined);
    expect(noToken.unauthorized).toEqual([]);
  });

  it('exposes field errors from a validation response', () => {
    const e = new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', { fields: [{ path: 'email', message: 'Invalid email' }, { path: 'password', message: 'Too short' }, { path: 'email', message: 'second' }] });
    expect(e.fieldErrors).toEqual({ email: 'Invalid email', password: 'Too short' });
    expect(new ApiError(400, 'X', 'm').fieldErrors).toEqual({});
  });

  it('classifies which outcomes are unknown (safe to retry with the same key)', () => {
    const unknown = [new ApiError(0, 'NETWORK_ERROR', ''), new ApiError(500, 'INTERNAL_ERROR', ''), new ApiError(503, 'X', ''), new ApiError(409, 'OPERATION_IN_PROGRESS', ''), new ApiError(409, 'REQUEST_IN_PROGRESS', '')];
    const definitive = [new ApiError(400, 'VALIDATION_ERROR', ''), new ApiError(402, 'PAYMENT_FAILED', ''), new ApiError(404, 'NOT_FOUND', ''), new ApiError(409, 'INVALID_TRANSITION', ''), new ApiError(409, 'STATE_CHANGED', ''), new ApiError(422, 'IDEMPOTENCY_KEY_REUSED', ''), new ApiError(429, 'LIMIT_EXCEEDED', '')];
    expect(unknown.every((e) => e.outcomeUnknown)).toBe(true);
    expect(definitive.some((e) => e.outcomeUnknown)).toBe(false);
  });
});

describe('idempotency keys', () => {
  it('generates unique keys the backend accepts (1-255 printable ASCII)', () => {
    const keys = new Set(Array.from({ length: 200 }, () => newIdempotencyKey()));
    expect(keys.size).toBe(200);
    for (const k of keys) expect(k).toMatch(/^[\x21-\x7E]{1,255}$/);
  });

  it('IntentKeys: stable per intention, dropped after a definitive answer, kept after an unknown one', () => {
    const k = new IntentKeys();
    const first = k.keyFor('upgrade:p1');
    expect(k.keyFor('upgrade:p1')).toBe(first);
    expect(k.keyFor('upgrade:p2')).not.toBe(first);

    k.settle('upgrade:p1', new ApiError(500, 'INTERNAL_ERROR', ''));
    expect(k.keyFor('upgrade:p1')).toBe(first); // retry of the same intention
    k.settle('upgrade:p1', new ApiError(402, 'PAYMENT_FAILED', ''));
    const second = k.keyFor('upgrade:p1');
    expect(second).not.toBe(first); // a decline ends the intention
    k.settle('upgrade:p1'); // success
    expect(k.keyFor('upgrade:p1')).not.toBe(second);
  });

  it('an unexpected (non-API) local error keeps the key: the outcome is unknown', () => {
    const k = new IntentKeys();
    const key = k.keyFor('x');
    k.settle('x', new Error('boom'));
    expect(k.keyFor('x')).toBe(key);
  });
});

describe('useIntentRunner (billing intentions)', () => {
  it('single flight: while one action runs, every other run (even a different one) is ignored', async () => {
    const { result } = renderHook(() => useIntentRunner());
    const gate = deferred();
    const action = vi.fn(async () => {
      await gate.promise;
      return 'done';
    });
    let first!: Promise<unknown>;
    act(() => {
      first = result.current.run('upgrade:p1', action);
    });
    expect(result.current.busy).toBe(true);
    let ignored: unknown[] = [];
    await act(async () => {
      ignored = await Promise.all([result.current.run('upgrade:p1', action), result.current.run('cancel', action)]);
    });
    expect(ignored).toEqual([{ status: 'ignored' }, { status: 'ignored' }]);
    gate.resolve();
    await act(async () => {
      expect(await first).toEqual({ status: 'ok', value: 'done' });
    });
    expect(action).toHaveBeenCalledTimes(1);
    expect(result.current.busy).toBe(false);
  });

  it('reuses the SAME key when a retry follows an unknown outcome, and a NEW key after success or a definitive failure', async () => {
    const { result } = renderHook(() => useIntentRunner());
    const seen: string[] = [];
    const outcomes: (ApiError | 'ok')[] = [new ApiError(0, 'NETWORK_ERROR', 'offline'), new ApiError(409, 'OPERATION_IN_PROGRESS', 'busy'), 'ok', new ApiError(402, 'PAYMENT_FAILED', 'declined'), 'ok'];
    const results: string[] = [];
    for (const outcome of outcomes) {
      await act(async () => {
        const r = await result.current.run('upgrade:p1', (key) => {
          seen.push(key);
          return outcome === 'ok' ? Promise.resolve('ok') : Promise.reject(outcome);
        });
        results.push(r.status === 'error' ? `error:${String(r.retrySameKey)}` : r.status);
      });
    }
    expect(results).toEqual(['error:true', 'error:true', 'ok', 'error:false', 'ok']);
    // 1st, 2nd, 3rd share a key (unknown, unknown, then the successful retry); 4th is a new intention; 5th a fresh one again
    expect(seen[0]).toBe(seen[1]);
    expect(seen[1]).toBe(seen[2]);
    expect(seen[3]).not.toBe(seen[2]);
    expect(seen[4]).not.toBe(seen[3]);
    expect(new Set(seen).size).toBe(3);
  });

  it('different intentions never share a key', async () => {
    const { result } = renderHook(() => useIntentRunner());
    const seen: string[] = [];
    for (const intent of ['upgrade:a', 'upgrade:b', 'cancel']) {
      await act(async () => {
        await result.current.run(intent, (key) => {
          seen.push(key);
          return Promise.reject(new ApiError(0, 'NETWORK_ERROR', 'offline'));
        });
      });
    }
    expect(new Set(seen).size).toBe(3);
  });

  it('wraps unexpected errors as an ApiError result instead of throwing', async () => {
    const { result } = renderHook(() => useIntentRunner());
    await act(async () => {
      const r = await result.current.run('x', () => Promise.reject(new Error('weird')));
      expect(r.status).toBe('error');
      if (r.status === 'error') expect(r.error).toBeInstanceOf(ApiError);
    });
  });
});
