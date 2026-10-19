/**
 * Session persistence. The JWT lives in localStorage so a reload keeps the user signed in (trade-off: readable by any
 * script on the page, so the app must stay free of XSS; the token is short-lived and the server is the authority).
 * Every access is guarded: storage can be unavailable (private mode, blocked cookies).
 */
const KEY = 'subcycle.session';

export interface StoredSession {
  token: string;
}

function safeStorage(): Storage | undefined {
  try {
    return typeof window !== 'undefined' ? window.localStorage : undefined;
  } catch {
    return undefined;
  }
}

export function loadSession(storage: Storage | undefined = safeStorage()): StoredSession | null {
  try {
    const raw = storage?.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && typeof (parsed as StoredSession).token === 'string' && (parsed as StoredSession).token) {
      return { token: (parsed as StoredSession).token };
    }
  } catch {
    /* corrupt or unavailable: behave as signed out */
  }
  return null;
}

export function saveSession(session: StoredSession, storage: Storage | undefined = safeStorage()): void {
  try {
    storage?.setItem(KEY, JSON.stringify(session));
  } catch {
    /* the session simply will not persist */
  }
}

export function clearSession(storage: Storage | undefined = safeStorage()): void {
  try {
    storage?.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
