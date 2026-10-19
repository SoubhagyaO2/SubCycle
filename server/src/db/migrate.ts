import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Pool } from 'pg';

export const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');
const MIGRATION_FILE = /^\d{4}_[a-z0-9_]+\.sql$/;
// Arbitrary constant key for pg_advisory_lock so concurrent runners serialise.
const ADVISORY_LOCK_KEY = 727_001;

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/** Applies pending `.sql` migrations in filename order, each in its own transaction. Forward-only. */
export async function runMigrations(pool: Pool, dir: string = MIGRATIONS_DIR): Promise<MigrationResult> {
  const files = (await readdir(dir)).filter((f) => MIGRATION_FILE.test(f)).sort();
  const client = await pool.connect();
  const result: MigrationResult = { applied: [], skipped: [] };
  try {
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       text PRIMARY KEY,
        checksum   text        NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const { rows } = await client.query<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migrations');
    const applied = new Map(rows.map((r) => [r.name, r.checksum]));

    for (const file of files) {
      const sql = await readFile(path.join(dir, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const existing = applied.get(file);
      if (existing !== undefined) {
        if (existing !== checksum) {
          throw new Error(`Migration ${file} was modified after being applied (checksum mismatch). Add a new migration instead.`);
        }
        result.skipped.push(file);
        continue;
      }
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw new Error(`Migration ${file} failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
      }
      result.applied.push(file);
    }
    return result;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}
