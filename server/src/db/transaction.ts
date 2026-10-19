import type { Pool, PoolClient } from 'pg';

/**
 * Runs `fn` inside a transaction: BEGIN, COMMIT on success, ROLLBACK on any error (which is re-thrown),
 * and the client is ALWAYS released. Never perform network / provider calls inside `fn`.
 */
export async function withTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let destroy = false;
  try {
    await client.query('BEGIN');
    try {
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        destroy = true; // connection is unusable; discard it instead of returning it to the pool
      }
      throw err;
    }
  } finally {
    client.release(destroy ? true : undefined);
  }
}
