import { useCallback, useRef, useState } from 'react';
import { ApiError } from '../api/client';
import { IntentKeys } from '../api/idempotency';

export type IntentResult<T> =
  | { status: 'ok'; value: T }
  | { status: 'error'; error: ApiError; /** The same intention can be retried with the same Idempotency-Key. */ retrySameKey: boolean }
  | { status: 'ignored' };

function toApiError(err: unknown): ApiError {
  return err instanceof ApiError ? err : new ApiError(0, 'UNEXPECTED', 'Something went wrong. Please try again.');
}

/**
 * Runs billing/lifecycle actions safely:
 *  - SINGLE FLIGHT: while one action is running every other `run` is ignored, so double clicks (or clicking a second
 *    button) can never create a second billing intention;
 *  - IDEMPOTENCY KEYS: one key per intention (see api/idempotency.ts): reused when a retry follows an unknown outcome,
 *    fresh after any definitive answer or for a different intention.
 * `busy` drives disabled buttons. The caller must only show success from an `ok` result (i.e. a real API answer).
 */
export function useIntentRunner() {
  const keys = useRef(new IntentKeys());
  const running = useRef(false);
  const [busy, setBusy] = useState(false);

  const run = useCallback(async <T,>(intent: string, action: (idempotencyKey: string) => Promise<T>): Promise<IntentResult<T>> => {
    if (running.current) return { status: 'ignored' };
    running.current = true;
    setBusy(true);
    const key = keys.current.keyFor(intent);
    try {
      const value = await action(key);
      keys.current.settle(intent);
      return { status: 'ok', value };
    } catch (err) {
      const error = toApiError(err);
      keys.current.settle(intent, error);
      return { status: 'error', error, retrySameKey: keys.current.has(intent) };
    } finally {
      running.current = false;
      setBusy(false);
    }
  }, []);

  return { run, busy };
}
