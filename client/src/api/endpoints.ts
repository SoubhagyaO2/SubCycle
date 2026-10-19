import type { ApiClient } from './client';
import type {
  AuthResult,
  BillingOperation,
  DemoReport,
  HistoryEvent,
  Invoice,
  Plan,
  Subscription,
  UpgradePreview,
  UsageHistoryPeriod,
  UsageReport,
  User,
} from './types';

/** One function per backend route. Mutations take the Idempotency-Key chosen by the caller (see idempotency.ts). */
export function createEndpoints(api: ApiClient) {
  type Opts = { signal?: AbortSignal };
  const sub = async (p: Promise<{ subscription: Subscription }>) => (await p).subscription;
  const withKey = (idempotencyKey: string, body?: unknown) => ({ idempotencyKey, ...(body !== undefined ? { body } : {}) });

  return {
    register: (input: { email: string; password: string; name: string }) => api.request<AuthResult>('POST', '/auth/register', { body: input, auth: false }),
    login: (input: { email: string; password: string }) => api.request<AuthResult>('POST', '/auth/login', { body: input, auth: false }),
    me: async (o: Opts = {}) => (await api.request<{ user: User }>('GET', '/auth/me', o)).user,

    plans: async (o: Opts = {}) => (await api.request<{ plans: Plan[] }>('GET', '/plans', { ...o, auth: false })).plans,
    currentSubscription: (o: Opts = {}) => sub(api.request('GET', '/subscriptions/current', o)),
    history: async (o: Opts = {}) => (await api.request<{ events: HistoryEvent[] }>('GET', '/subscriptions/history', o)).events,
    upgradePreview: async (planId: string, o: Opts = {}) =>
      (await api.request<{ preview: UpgradePreview }>('GET', `/subscriptions/upgrade-preview?planId=${encodeURIComponent(planId)}`, o)).preview,
    invoices: async (o: Opts = {}) => (await api.request<{ invoices: Invoice[] }>('GET', '/invoices', o)).invoices,
    operations: async (o: Opts = {}) => (await api.request<{ operations: BillingOperation[] }>('GET', '/billing/operations', o)).operations,

    subscribe: (planId: string, key: string) => sub(api.request('POST', '/subscriptions', withKey(key, { planId }))),
    upgrade: (planId: string, key: string) => sub(api.request('POST', '/subscriptions/upgrade', withKey(key, { planId }))),
    downgrade: (planId: string, key: string) => sub(api.request('POST', '/subscriptions/downgrade', withKey(key, { planId }))),
    removePendingChange: (key: string) => sub(api.request('DELETE', '/subscriptions/pending-change', withKey(key))),
    pause: (key: string) => sub(api.request('POST', '/subscriptions/pause', withKey(key))),
    resume: (key: string) => sub(api.request('POST', '/subscriptions/resume', withKey(key))),
    cancel: (key: string, immediate = false) => sub(api.request('POST', '/subscriptions/cancel', withKey(key, immediate ? { immediate: true } : undefined))),
    reactivate: (key: string) => sub(api.request('POST', '/subscriptions/reactivate', withKey(key))),

    usage: (o: Opts = {}) => api.request<UsageReport>('GET', '/usage', o),
    usageHistory: async (o: Opts = {}) => (await api.request<{ periods: UsageHistoryPeriod[] }>('GET', '/usage/history', o)).periods,
    generateReport: () => api.request<DemoReport>('POST', '/demo/generate-report'),
  };
}

export type Endpoints = ReturnType<typeof createEndpoints>;
