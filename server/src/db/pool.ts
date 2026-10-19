import { Pool, type PoolConfig } from 'pg';

export type { Pool, PoolClient } from 'pg';

export function createPool(connectionString: string, options: Omit<PoolConfig, 'connectionString'> = {}): Pool {
  const pool = new Pool({ connectionString, max: 10, ...options });
  // An idle client erroring must not crash the process; the pool discards it.
  pool.on('error', (err) => {
    console.error('Unexpected PostgreSQL pool error:', err.message);
  });
  return pool;
}
