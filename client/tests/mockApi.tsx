import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import App from '../src/App';
import type { BillingOperation, HistoryEvent, Invoice, Plan, Subscription, UsageHistoryPeriod, UsageReport, User } from '../src/api/types';

export const API = 'http://api.test';

export interface RecordedCall {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
  headers: Record<string, string>;
}

export interface MockResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Delays the response until this promise resolves (deterministic in-flight control, no timers). */
  gate?: Promise<void>;
  /** Simulate a network failure (fetch rejects). */
  networkError?: boolean;
}
export type Handler = MockResponse | ((call: RecordedCall) => MockResponse | Promise<MockResponse>);

export class MockApi {
  readonly calls: RecordedCall[] = [];
  private readonly routes = new Map<string, Handler>();

  on(route: string, handler: Handler): this {
    this.routes.set(route, handler);
    return this;
  }

  callsTo(route: string): RecordedCall[] {
    const [method, path] = route.split(' ') as [string, string];
    return this.calls.filter((c) => c.method === method && c.path === path);
  }

  install(): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        const method = (init?.method ?? 'GET').toUpperCase();
        const path = url.pathname;
        const headers: Record<string, string> = {};
        new Headers(init?.headers).forEach((v, k) => (headers[k.toLowerCase()] = v));
        let body: unknown = undefined;
        if (typeof init?.body === 'string') body = JSON.parse(init.body);
        const call: RecordedCall = { method, path, query: Object.fromEntries(url.searchParams), body, headers };
        this.calls.push(call);

        const handler = this.routes.get(`${method} ${path}`);
        if (!handler) return json(404, { error: { code: 'ROUTE_NOT_FOUND', message: `No mock for ${method} ${path}`, details: {} } });
        const res = typeof handler === 'function' ? await handler(call) : handler;
        if (res.gate) await res.gate;
        if (res.networkError) throw new TypeError('Failed to fetch');
        return json(res.status ?? 200, res.body, res.headers);
      }),
    );
  }
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

export const err = (status: number, code: string, message: string, details: Record<string, unknown> = {}): MockResponse => ({ status, body: { error: { code, message, details } } });

/** A promise you resolve by hand: models "the request is still in flight". */
export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

// ---- fixtures (test data only; the app itself contains none) ---------------------------------------------------------

export const plans: Plan[] = [
  { id: 'plan-free', code: 'free', name: 'Free', priceCents: 0, interval: 'month', limits: { api_calls: 100, projects: 1, seats: 1 } },
  { id: 'plan-pro', code: 'pro_monthly', name: 'Pro', priceCents: 49_900, interval: 'month', limits: { api_calls: 5000, projects: 10, seats: 3 } },
  { id: 'plan-biz', code: 'business_monthly', name: 'Business', priceCents: 149_900, interval: 'month', limits: { api_calls: 50_000, projects: 100, seats: 25 } },
  { id: 'plan-pro-y', code: 'pro_yearly', name: 'Pro (Yearly)', priceCents: 499_900, interval: 'year', limits: { api_calls: 60_000, projects: 10, seats: 3 } },
];
export const [FREE, PRO, BIZ, PRO_Y] = plans as [Plan, Plan, Plan, Plan];

export const user: User = { id: 'user-1', email: 'alice@example.com', name: 'Alice', createdAt: '2026-01-01T00:00:00.000Z' };

export function makeSub(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: 'sub-1',
    status: 'active',
    plan: PRO,
    pendingPlan: null,
    currentPeriodStart: '2026-01-01T00:00:00.000Z',
    currentPeriodEnd: '2026-02-01T00:00:00.000Z',
    cancelAtPeriodEnd: false,
    cancelRequestedAt: null,
    pausedAt: null,
    canceledAt: null,
    cancelReason: null,
    pastDueSince: null,
    graceEndsAt: null,
    retryCount: 0,
    nextRetryAt: null,
    accessAllowed: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function makeUsage(overrides: Partial<UsageReport> = {}): UsageReport {
  return {
    subscription: { id: 'sub-1', status: 'active', accessAllowed: true, graceEndsAt: null },
    period: { start: '2026-01-01T00:00:00.000Z', end: '2026-02-01T00:00:00.000Z' },
    usage: [
      { metric: 'api_calls', used: 4200, limit: 5000, remaining: 800, unlimited: false },
      { metric: 'projects', used: 2, limit: 10, remaining: 8, unlimited: false },
      { metric: 'seats', used: 0, limit: null, remaining: null, unlimited: true },
    ],
    ...overrides,
  };
}

/** A mock with the routes every signed-in screen needs; tests override what they care about. */
export function signedInApi(sub: Subscription | null = makeSub()): MockApi {
  const api = new MockApi();
  api.on('GET /auth/me', { body: { user } });
  api.on('GET /plans', { body: { plans } });
  api.on('GET /subscriptions/current', sub ? { body: { subscription: sub } } : err(404, 'SUBSCRIPTION_NOT_FOUND', 'No active subscription found'));
  api.on('GET /usage', sub ? { body: makeUsage() } : err(404, 'SUBSCRIPTION_NOT_FOUND', 'No active subscription found'));
  api.on('GET /usage/history', { body: { periods: [] as UsageHistoryPeriod[] } });
  api.on('GET /invoices', { body: { invoices: [] as Invoice[] } });
  api.on('GET /billing/operations', { body: { operations: [] as BillingOperation[] } });
  api.on('GET /subscriptions/history', { body: { events: [] as HistoryEvent[] } });
  return api;
}

export function signIn(token = 'test-token'): void {
  window.localStorage.setItem('subcycle.session', JSON.stringify({ token }));
}

export function renderApp(path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App apiBaseUrl={API} />
    </MemoryRouter>,
  );
}
