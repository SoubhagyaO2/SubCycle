/**
 * Fresh-database migration + seed check (runs in CI and locally: `npm run db:check-fresh`).
 *
 * Creates a brand-new temporary database on the server that DATABASE_URL points at, then verifies that
 *   1. every migration applies cleanly from nothing,
 *   2. re-running the migrations is a no-op,
 *   3. seeding is repeatable (running it three times leaves exactly the four seed plans),
 *   4. the expected tables exist,
 * and drops the database again. Needs no psql, so it works the same on every OS.
 */
import { readdirSync } from 'node:fs';
import { loadConfig } from '../src/config';
import { MIGRATIONS_DIR, runMigrations } from '../src/db/migrate';
import { createPool } from '../src/db/pool';
import { SEED_PLANS, seedPlans } from '../src/db/seed';

const EXPECTED_TABLES = ['billing_operations', 'demo_reports', 'idempotency_keys', 'invoices', 'plans', 'schema_migrations', 'subscription_events', 'subscriptions', 'usage_events', 'usage_records', 'users'];

function check(ok: boolean, what: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`);
  if (!ok) process.exitCode = 1;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const name = `subcycle_fresh_check_${process.pid}`;
  const admin = new URL(config.DATABASE_URL);
  admin.pathname = '/postgres';
  const adminPool = createPool(admin.toString(), { max: 1 });
  const fresh = new URL(config.DATABASE_URL);
  fresh.pathname = `/${name}`;

  await adminPool.query(`DROP DATABASE IF EXISTS ${name}`);
  await adminPool.query(`CREATE DATABASE ${name}`);
  const pool = createPool(fresh.toString(), { max: 2 });
  try {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f));
    const first = await runMigrations(pool);
    check(first.applied.length === files.length && first.applied.length > 0, `all ${files.length} migrations apply to an empty database`);
    const second = await runMigrations(pool);
    check(second.applied.length === 0 && second.skipped.length === files.length, 'a second migration run is a no-op');

    for (let i = 0; i < 3; i++) await seedPlans(pool);
    const plans = await pool.query<{ code: string }>('SELECT code FROM plans ORDER BY code');
    check(plans.rows.length === SEED_PLANS.length && plans.rows.map((r) => r.code).join() === SEED_PLANS.map((p) => p.code).sort().join(), `seeding three times leaves exactly ${SEED_PLANS.length} plans`);

    const tables = await pool.query<{ table_name: string }>(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`);
    check(tables.rows.map((r) => r.table_name).join() === EXPECTED_TABLES.join(), `schema has exactly the expected ${EXPECTED_TABLES.length} tables`);

    const recorded = await pool.query<{ n: string }>('SELECT count(*) AS n FROM schema_migrations');
    check(Number(recorded.rows[0]!.n) === files.length, 'schema_migrations records every file');
  } finally {
    await pool.end();
    await adminPool.query(`DROP DATABASE IF EXISTS ${name}`);
    await adminPool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
