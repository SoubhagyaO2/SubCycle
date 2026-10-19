import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api/client';

export interface Resource<T> {
  data: T | undefined;
  error: ApiError | null;
  /** True until the first result (success or error) for the current inputs arrives. */
  loading: boolean;
  reload: () => void;
}

interface Result<T> {
  /** Which inputs this result belongs to; a result for other inputs is treated as "not loaded yet". */
  key: string;
  data: T | undefined;
  error: ApiError | null;
}

function toApiError(err: unknown): ApiError {
  return err instanceof ApiError ? err : new ApiError(0, 'UNEXPECTED', 'Something went wrong. Please try again.');
}

/**
 * Loads data from the API. Keeps the previous value while re-fetching the same inputs, starts clean when the inputs
 * change, ignores stale responses and aborted requests, and can poll (used while the server says a renewal is being
 * processed). State is derived from the result's key, so no state is set synchronously inside an effect.
 */
export function useResource<T>(fetcher: (signal: AbortSignal) => Promise<T>, deps: readonly unknown[], opts: { pollMs?: number | null } = {}): Resource<T> {
  const key = JSON.stringify(deps);
  const [result, setResult] = useState<Result<T> | null>(null);
  const [tick, setTick] = useState(0);
  const fetcherRef = useRef(fetcher);

  useEffect(() => {
    fetcherRef.current = fetcher;
  });

  useEffect(() => {
    const controller = new AbortController();
    fetcherRef
      .current(controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setResult({ key, data, error: null });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
        setResult((prev) => ({ key, data: prev?.key === key ? prev.data : undefined, error: toApiError(err) }));
      });
    return () => controller.abort();
  }, [tick, key]);

  const pollMs = opts.pollMs ?? null;
  useEffect(() => {
    if (!pollMs) return undefined;
    const id = setInterval(() => setTick((t) => t + 1), pollMs);
    return () => clearInterval(id);
  }, [pollMs]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  const current = result?.key === key ? result : null;
  return { data: current?.data, error: current?.error ?? null, loading: current === null, reload };
}
