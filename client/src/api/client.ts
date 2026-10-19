/** Typed HTTP client for the SubCycle API. Knows nothing about React. */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  get isNetwork(): boolean {
    return this.code === 'NETWORK_ERROR';
  }

  /**
   * True when we cannot know whether the server applied the request: network failure, 5xx, or the server saying the
   * work is still in flight. Only then may a retry reuse the same Idempotency-Key; every definitive answer
   * (success or 4xx, including a 402 decline that the server replays for a stored key) ends the intention.
   */
  get outcomeUnknown(): boolean {
    return this.isNetwork || this.status >= 500 || (this.status === 409 && (this.code === 'OPERATION_IN_PROGRESS' || this.code === 'REQUEST_IN_PROGRESS'));
  }

  /** Field-level validation messages from a 400 VALIDATION_ERROR, keyed by field path. */
  get fieldErrors(): Record<string, string> {
    const fields = this.details.fields;
    const out: Record<string, string> = {};
    if (Array.isArray(fields)) {
      for (const f of fields as { path?: unknown; message?: unknown }[]) {
        if (typeof f.path === 'string' && typeof f.message === 'string' && !(f.path in out)) out[f.path] = f.message;
      }
    }
    return out;
  }
}

export type UnauthorizedReason = 'expired' | 'invalid';

export interface ApiConfig {
  baseUrl: string;
  getToken(): string | null;
  /** Called when an authenticated request is rejected with 401 (session over). */
  onUnauthorized(reason: UnauthorizedReason): void;
}

export interface RequestOptions {
  body?: unknown;
  idempotencyKey?: string;
  signal?: AbortSignal;
  /** false for login/register: a 401 there is a wrong password, not an expired session. */
  auth?: boolean;
}

export class ApiClient {
  constructor(private readonly cfg: ApiConfig) {}

  async request<T>(method: 'GET' | 'POST' | 'DELETE', path: string, opts: RequestOptions = {}): Promise<T> {
    const token = opts.auth === false ? null : this.cfg.getToken();
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;

    let res: Response;
    try {
      res = await fetch(`${this.cfg.baseUrl}${path}`, {
        method,
        headers,
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the server. Check your connection and try again.');
    }

    let payload: unknown = null;
    const text = await res.text();
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
    }

    if (res.ok) return payload as T;

    const error = (payload as { error?: { code?: unknown; message?: unknown; details?: unknown } } | null)?.error;
    const code = typeof error?.code === 'string' ? error.code : `HTTP_${res.status}`;
    const message = typeof error?.message === 'string' ? error.message : 'Something went wrong. Please try again.';
    const details = error?.details && typeof error.details === 'object' ? (error.details as Record<string, unknown>) : {};
    const apiError = new ApiError(res.status, code, message, details);

    if (res.status === 401 && token) this.cfg.onUnauthorized(code === 'TOKEN_EXPIRED' ? 'expired' : 'invalid');
    throw apiError;
  }
}
