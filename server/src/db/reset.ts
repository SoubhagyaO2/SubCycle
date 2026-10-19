import type { Pool } from 'pg';
import { runMigrations, type MigrationResult } from './migrate';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Guards against wiping a real database. Throws if the reset is not allowed. */
export function assertResetAllowed(opts: { nodeEnv: string; databaseUrl: string; allowRemote: boolean }): void {
  if (opts.nodeEnv === 'production') throw new Error('Refusing to reset the database when NODE_ENV=production');
  const host = new URL(opts.databaseUrl).hostname;
  if (!LOCAL_HOSTS.has(host) && !opts.allowRemote) {
    throw new Error(`Refusing to reset non-local database host "${host}" (set ALLOW_DB_RESET=true to override)`);
  }
}

/** Drops and recreates the public schema, then re-applies all migrations. Dev/test only. */
export async function resetDatabase(pool: Pool): Promise<MigrationResult> {
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
  await pool.query('CREATE SCHEMA public');
  return runMigrations(pool);
}
