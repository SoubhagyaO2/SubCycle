import { createHash } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { Pool } from 'pg';
import { withTransaction } from '../db/transaction';
import type { Clock } from '../lib/clock';
import { AppError, conflict, unauthenticated, validationError } from '../lib/errors';

const LOCK_MS = 60_000; // an in-progress request is considered abandoned after this
const TTL_MS = 24 * 60 * 60 * 1000;
const KEY_PATTERN = /^[\x21-\x7E]{1,255}$/;
/** Transient outcomes are never stored, so the same key can be retried and will resume the work. */
const NOT_STORED_CODES = new Set(['OPERATION_IN_PROGRESS', 'REQUEST_IN_PROGRESS', 'RATE_LIMITED']);

type Claim = { kind: 'proceed' } | { kind: 'replay'; status: number; body: unknown };

/** Deterministic JSON with sorted keys, so equivalent bodies hash identically. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function requestHash(method: string, path: string, body: unknown): string {
  return createHash('sha256').update(`${method}
${path}
${canonical(body)}`).digest('hex');
}

/**
 * HTTP `Idempotency-Key` support (docs/DECISIONS.md B7), scoped per authenticated user. Must run after `authenticate`.
 *  - repeated identical request  -> original status/body, header `Idempotent-Replay: true`, no second execution
 *  - same key, different request -> 422 IDEMPOTENCY_KEY_REUSED
 *  - same key still running      -> 409 REQUEST_IN_PROGRESS
 *  - abandoned (process died)    -> after the lock expires the next identical request takes over and re-runs; the
 *                                   handler is safe to re-run because billing is idempotent per obligation
 */
export function idempotency(deps: { pool: Pool; clock: Clock }): RequestHandler {
  return async (req, res, next) => {
    const key = req.header('Idempotency-Key');
    if (key === undefined) {
      next();
      return;
    }
    if (!req.user) throw unauthenticated();
    if (!KEY_PATTERN.test(key)) throw validationError('Idempotency-Key must be 1-255 printable ASCII characters');

    const userId = req.user.id;
    const path = `${req.baseUrl}${req.path}`;
    const hash = createHash('sha256').update(`${req.method}\n${path}\n${canonical(req.body)}`).digest('hex');

    const claim = await claimKey(deps, userId, key, req.method, path, hash);
    if (claim.kind === 'replay') {
      res.setHeader('Idempotent-Replay', 'true');
      res.status(claim.status).json(claim.body);
      return;
    }

    // Persist the outcome BEFORE sending it, so a client that retries immediately always sees the stored result.
    const send = res.json.bind(res);
    res.json = (body: unknown) => {
      const status = res.statusCode;
      finishKey(deps, userId, key, status, body)
        .catch(() => undefined)
        .finally(() => {
          send(body);
        });
      return res;
    };
    next();
  };
}

async function claimKey(deps: { pool: Pool; clock: Clock }, userId: string, key: string, method: string, path: string, hash: string): Promise<Claim> {
  return withTransaction(deps.pool, async (client) => {
    const now = deps.clock.now();
    const lockedUntil = new Date(now.getTime() + LOCK_MS);
    const expiresAt = new Date(now.getTime() + TTL_MS);

    const inserted = await client.query(
      `INSERT INTO idempotency_keys (user_id, key, request_method, request_path, request_hash, status, locked_until, expires_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'in_progress', $6, $7, $8, $8)
       ON CONFLICT (user_id, key) DO NOTHING RETURNING id`,
      [userId, key, method, path, hash, lockedUntil, expiresAt, now],
    );
    if (inserted.rowCount) return { kind: 'proceed' };

    const { rows } = await client.query<{
      id: string;
      request_method: string;
      request_path: string;
      request_hash: string;
      status: 'in_progress' | 'completed';
      locked_until: Date;
      expires_at: Date;
      response_status: number | null;
      response_body: unknown;
    }>('SELECT * FROM idempotency_keys WHERE user_id = $1 AND key = $2 FOR UPDATE', [userId, key]);
    const row = rows[0]!;

    if (row.expires_at.getTime() <= now.getTime()) {
      // Expired: the key can be reused for any request.
      await client.query(
        `UPDATE idempotency_keys SET request_method = $2, request_path = $3, request_hash = $4, status = 'in_progress', locked_until = $5,
           expires_at = $6, response_status = NULL, response_body = NULL, updated_at = $7 WHERE id = $1`,
        [row.id, method, path, hash, lockedUntil, expiresAt, now],
      );
      return { kind: 'proceed' };
    }
    if (row.request_hash !== hash || row.request_method !== method || row.request_path !== path) {
      throw new AppError(422, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used with a different request');
    }
    if (row.status === 'completed') return { kind: 'replay', status: row.response_status!, body: row.response_body };
    if (row.locked_until.getTime() > now.getTime()) {
      throw conflict('REQUEST_IN_PROGRESS', 'A request with this Idempotency-Key is still being processed');
    }
    // Abandoned: take it over.
    await client.query('UPDATE idempotency_keys SET locked_until = $2, updated_at = $3 WHERE id = $1', [row.id, lockedUntil, now]);
    return { kind: 'proceed' };
  });
}

async function finishKey(deps: { pool: Pool; clock: Clock }, userId: string, key: string, status: number, body: unknown): Promise<void> {
  const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
  const transient = status >= 500 || (typeof code === 'string' && NOT_STORED_CODES.has(code));
  if (transient) {
    await deps.pool.query(`DELETE FROM idempotency_keys WHERE user_id = $1 AND key = $2 AND status = 'in_progress'`, [userId, key]);
    return;
  }
  await deps.pool.query(
    `UPDATE idempotency_keys SET status = 'completed', response_status = $3, response_body = $4::jsonb, updated_at = $5
     WHERE user_id = $1 AND key = $2`,
    [userId, key, status, JSON.stringify(body), deps.clock.now()],
  );
}
