import type { RequestHandler } from 'express';
import type { Pool, PoolClient } from 'pg';
import type { Clock } from '../lib/clock';
import { internalErrorBody, unauthenticated } from '../lib/errors';
import { consumeUsage, type ConsumeResult } from '../services/usageService';

/** Handed to the route handler: do the metered DB work on `client` so it commits atomically with the usage. */
export interface Meter {
  client: PoolClient;
  usage: ConsumeResult;
}

/**
 * enforceLimit(metric, quantity = 1): server-side enforcement (docs/DECISIONS.md B13a).
 *
 * Opens a transaction, rejects ineligible subscriptions (402) or over-limit requests (429) BEFORE any work, atomically
 * consumes the usage, and runs the handler inside that same transaction (`req.meter.client`). The transaction is
 * finalized BEFORE the response is sent:
 *   status < 400  -> COMMIT (usage and the handler's writes become durable together);
 *   status >= 400 -> ROLLBACK (a failed request consumes nothing);
 *   COMMIT fails  -> the client gets a 500, never a success body, and nothing was consumed.
 * Requires `authenticate` to have run.
 */
export function enforceLimit(deps: { pool: Pool; clock: Clock }, metric: string, quantity = 1): RequestHandler {
  return async (req, res, next) => {
    if (!req.user) throw unauthenticated();
    const client = await deps.pool.connect();
    let finalized = false;
    let abandoned = false;

    const finalize = async (commit: boolean): Promise<void> => {
      if (finalized) return;
      finalized = true;
      let destroy = false;
      try {
        await client.query(commit && !abandoned ? 'COMMIT' : 'ROLLBACK');
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch {
          destroy = true; // connection unusable: discard instead of returning it to the pool
        }
        throw err;
      } finally {
        client.release(destroy ? true : undefined);
      }
    };

    try {
      await client.query('BEGIN');
      const usage = await consumeUsage(client, deps, { userId: req.user.id, metric, quantity, source: 'demo' });
      req.meter = { client, usage };
    } catch (err) {
      await finalize(false).catch(() => undefined);
      throw err;
    }

    const send = res.json.bind(res);
    res.json = (body: unknown) => {
      finalize(res.statusCode < 400).then(
        () => send(body),
        () => {
          // The work "succeeded" but the commit did not: tell the truth.
          res.status(500);
          send(internalErrorBody());
        },
      );
      return res;
    };
    // If the client goes away mid-request the handler still ends (via res.json); make sure that path rolls back.
    res.on('close', () => {
      if (!res.writableFinished) abandoned = true;
    });
    next();
  };
}
