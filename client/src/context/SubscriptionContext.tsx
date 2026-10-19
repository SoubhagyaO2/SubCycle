import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { ApiError } from '../api/client';
import type { Subscription } from '../api/types';
import { useResource } from '../hooks/useResource';
import { phaseOf } from '../lib/subscriptionState';
import { useApi } from './AuthContext';

interface SubscriptionContextValue {
  /** loading: first fetch; none: the server says there is no open subscription; ready; error. */
  state: 'loading' | 'none' | 'ready' | 'error';
  subscription: Subscription | null;
  error: ApiError | null;
  refresh: () => void;
  /** Show a server-confirmed subscription immediately (from a mutation response), then re-sync. */
  adopt: (subscription: Subscription) => void;
}

const SubscriptionContext = createContext<SubscriptionContextValue | null>(null);

const RENEWAL_POLL_MS = 5000;

/**
 * Single source of the current subscription for the signed-in area. While the server reports that a period has ended
 * and renewal is being processed, it polls so the screen follows the server (renewed, past_due, canceled) by itself.
 */
export function SubscriptionProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const [override, setOverride] = useState<Subscription | null>(null);
  const [pollMs, setPollMs] = useState<number | null>(null);

  const resource = useResource<Subscription | null>(async (signal) => {
    try {
      const sub = await api.currentSubscription({ signal });
      setOverride(null);
      setPollMs(phaseOf(sub) === 'renewal_processing' ? RENEWAL_POLL_MS : null);
      return sub;
    } catch (err) {
      if (err instanceof ApiError && err.code === 'SUBSCRIPTION_NOT_FOUND') {
        setPollMs(null);
        return null;
      }
      throw err;
    }
  }, [api], { pollMs });

  const adopt = useCallback((s: Subscription) => setOverride(s), []);
  const { reload } = resource;

  const value = useMemo<SubscriptionContextValue>(() => {
    const subscription = override ?? resource.data ?? null;
    const state: SubscriptionContextValue['state'] = resource.loading && !override ? 'loading' : resource.error && !subscription ? 'error' : subscription ? 'ready' : 'none';
    return { state, subscription, error: resource.error, refresh: reload, adopt };
  }, [override, resource.data, resource.loading, resource.error, reload, adopt]);

  return <SubscriptionContext.Provider value={value}>{children}</SubscriptionContext.Provider>;
}

export function useSubscription(): SubscriptionContextValue {
  const ctx = useContext(SubscriptionContext);
  if (!ctx) throw new Error('useSubscription must be used inside <SubscriptionProvider>');
  return ctx;
}
