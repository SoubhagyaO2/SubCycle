import type { RequestHandler } from 'express';
import type { Pool } from 'pg';
import type { Clock } from '../lib/clock';

export function healthController(pool: Pool, clock: Clock): RequestHandler {
  return async (_req, res) => {
    let database: 'up' | 'down' = 'up';
    try {
      await pool.query('SELECT 1');
    } catch {
      database = 'down';
    }
    res.status(database === 'up' ? 200 : 503).json({
      status: database === 'up' ? 'ok' : 'degraded',
      database,
      time: clock.now().toISOString(),
    });
  };
}
