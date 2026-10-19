import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ApiClient, ApiError, type UnauthorizedReason } from '../api/client';
import { createEndpoints, type Endpoints } from '../api/endpoints';
import type { AuthResult, User } from '../api/types';
import { clearSession, loadSession, saveSession } from '../lib/storage';

export type AuthStatus = 'loading' | 'authenticated' | 'anonymous' | 'unavailable';

interface AuthContextValue {
  status: AuthStatus;
  user: User | null;
  /** Why the user was sent back to the login screen (e.g. expired session). */
  sessionMessage: string | null;
  login: (input: { email: string; password: string }) => Promise<void>;
  register: (input: { email: string; password: string; name: string }) => Promise<void>;
  logout: () => void;
  clearSessionMessage: () => void;
  /** Re-check the stored session (used by the "retry" button when the API was unreachable). */
  retryBootstrap: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);
const ApiContext = createContext<Endpoints | null>(null);

class TokenStore {
  private token: string | null;
  constructor(initial: string | null) {
    this.token = initial;
  }
  get(): string | null {
    return this.token;
  }
  set(token: string | null): void {
    this.token = token;
  }
}

const MESSAGES: Record<UnauthorizedReason, string> = {
  expired: 'Your session has expired. Please sign in again.',
  invalid: 'Please sign in again to continue.',
};

export function AuthProvider({ apiBaseUrl, children }: { apiBaseUrl: string; children: ReactNode }) {
  const [initialToken] = useState(() => loadSession()?.token ?? null);
  // Mutable token holder (not React state, not read during render): the API client asks it for the token on every request.
  const [tokens] = useState(() => new TokenStore(initialToken));
  const [status, setStatus] = useState<AuthStatus>(initialToken ? 'loading' : 'anonymous');
  const [user, setUser] = useState<User | null>(null);
  const [sessionMessage, setSessionMessage] = useState<string | null>(null);
  const [bootstrapTick, setBootstrapTick] = useState(0);

  const endSession = useCallback((message: string | null) => {
    tokens.set(null);
    clearSession();
    setUser(null);
    setStatus('anonymous');
    setSessionMessage(message);
  }, [tokens]);

  const endpoints = useMemo(() => {
    const client = new ApiClient({
      baseUrl: apiBaseUrl,
      getToken: () => tokens.get(),
      // A 401 on an authenticated request means the session is over: return to login, never crash.
      onUnauthorized: (reason) => endSession(MESSAGES[reason]),
    });
    return createEndpoints(client);
  }, [apiBaseUrl, endSession, tokens]);

  // Persistent login: validate the stored token with the server before trusting it.
  useEffect(() => {
    if (!tokens.get()) return undefined;
    const controller = new AbortController();
    endpoints
      .me({ signal: controller.signal })
      .then((u) => {
        if (controller.signal.aborted) return;
        setUser(u);
        setStatus('authenticated');
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        // 401 already ended the session via onUnauthorized. Anything else (server down) must NOT log the user out.
        if (!(err instanceof ApiError) || err.status !== 401) setStatus('unavailable');
      });
    return () => controller.abort();
  }, [endpoints, bootstrapTick, tokens]);

  const adopt = useCallback((result: AuthResult) => {
    tokens.set(result.token);
    saveSession({ token: result.token });
    setUser(result.user);
    setSessionMessage(null);
    setStatus('authenticated');
  }, [tokens]);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      sessionMessage,
      login: async (input) => adopt(await endpoints.login(input)),
      register: async (input) => adopt(await endpoints.register(input)),
      logout: () => endSession(null),
      clearSessionMessage: () => setSessionMessage(null),
      retryBootstrap: () => {
        setStatus('loading');
        setBootstrapTick((t) => t + 1);
      },
    }),
    [status, user, sessionMessage, adopt, endpoints, endSession],
  );

  return (
    <ApiContext.Provider value={endpoints}>
      <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
    </ApiContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

export function useApi(): Endpoints {
  const ctx = useContext(ApiContext);
  if (!ctx) throw new Error('useApi must be used inside <AuthProvider>');
  return ctx;
}
