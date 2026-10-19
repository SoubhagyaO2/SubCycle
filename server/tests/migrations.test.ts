import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, type Pool } from '../src/db/pool';
import { runMigrations } from '../src/db/migrate';
import { assertResetAllowed, resetDatabase } from '../src/db/reset';
import { seedPlans, SEED_PLANS } from '../src/db/seed';
import { testDatabaseUrl } from './testEnv';

// Uses a throwaway database so the shared test database is never touched.
const SCRATCH_DB = 'subcycle_migrations_scratch_test';
let admin: Pool;
let scratch: Pool;
let tmpDir: string;

beforeAll(async () => {
  const adminUrl = new URL(testDatabaseUrl());
  adminUrl.pathname = '/postgres';
  admin = createPool(adminUrl.toString(), { max: 1 });
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
  await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);
  const scratchUrl = new URL(testDatabaseUrl());
  scratchUrl.pathname = `/${SCRATCH_DB}`;
  scratch = createPool(scratchUrl.toString(), { max: 4 });
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'subcycle-mig-'));
});

afterAll(async () => {
  await scratch.end();
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
  await admin.end();
  await rm(tmpDir, { recursive: true, force: true });
});

describe('migration runner', () => {
  it('applies all migrations to a fresh database, then is a no-op when re-run', async () => {
    const first = await runMigrations(scratch);
    expect(first.applied).toEqual([
      '0001_users_plans.sql',
      '0002_subscriptions.sql',
      '0003_billing.sql',
      '0004_events_usage_idempotency.sql',
      '0005_event_sequence.sql',
      '0006_usage_ledger_demo.sql',
    ]);
    const second = await runMigrations(scratch);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toHaveLength(6);
  });

  it('is safe when two runners start concurrently on a fresh database', async () => {
    await scratch.query('DROP SCHEMA public CASCADE');
    await scratch.query('CREATE SCHEMA public');
    const results = await Promise.all([runMigrations(scratch), runMigrations(scratch)]);
    expect(results.flatMap((r) => r.applied)).toHaveLength(6); // each migration applied exactly once
  });

  it('rejects a modified, already-applied migration (checksum)', async () => {
    await scratch.query('DROP SCHEMA public CASCADE');
    await scratch.query('CREATE SCHEMA public');
    await writeFile(path.join(tmpDir, '0001_a.sql'), 'CREATE TABLE a (id int);');
    await runMigrations(scratch, tmpDir);
    await writeFile(path.join(tmpDir, '0001_a.sql'), 'CREATE TABLE a (id bigint);');
    await expect(runMigrations(scratch, tmpDir)).rejects.toThrow(/modified after being applied/);
  });

  it('rolls back a failing migration entirely and does not record it', async () => {
    await scratch.query('DROP SCHEMA public CASCADE');
    await scratch.query('CREATE SCHEMA public');
    await writeFile(path.join(tmpDir, '0001_a.sql'), 'CREATE TABLE a (id int);');
    await writeFile(path.join(tmpDir, '0002_bad.sql'), 'CREATE TABLE b (id int); SELECT 1/0;');
    await expect(runMigrations(scratch, tmpDir)).rejects.toThrow(/0002_bad.sql failed/);
    const { rows } = await scratch.query<{ t: string | null }>(`SELECT to_regclass('public.b') AS t`);
    expect(rows[0]!.t).toBeNull();
    const applied = await scratch.query<{ name: string }>('SELECT name FROM schema_migrations');
    expect(applied.rows.map((r) => r.name)).toEqual(['0001_a.sql']);
  });
});

describe('seed', () => {
  it('is repeatable: running it multiple times yields the same plans, no duplicates', async () => {
    await resetDatabase(scratch);
    await seedPlans(scratch);
    const snapshot = async (): Promise<{ code: string }[]> => {
      const res = await scratch.query<{ code: string }>('SELECT code, name, price_cents, interval, limits FROM plans ORDER BY code');
      return res.rows;
    };
    const first = await snapshot();
    await seedPlans(scratch);
    await seedPlans(scratch);
    const again = await snapshot();
    expect(again).toEqual(first);
    expect(again).toHaveLength(SEED_PLANS.length);
    expect(again.map((p) => p.code)).toEqual(['business_monthly', 'free', 'pro_monthly', 'pro_yearly']);
  });

  it('restores drifted values on re-seed', async () => {
    await scratch.query(`UPDATE plans SET price_cents = 1 WHERE code = 'pro_monthly'`);
    await seedPlans(scratch);
    const { rows } = await scratch.query<{ price_cents: number }>(`SELECT price_cents FROM plans WHERE code = 'pro_monthly'`);
    expect(rows[0]!.price_cents).toBe(49_900);
  });

  it('seeds a free plan at 0 and a yearly plan to exercise interval rejection', () => {
    expect(SEED_PLANS.find((p) => p.code === 'free')?.priceCents).toBe(0);
    expect(SEED_PLANS.filter((p) => p.interval === 'year')).toHaveLength(1);
  });
});

describe('reset guard', () => {
  const local = 'postgres://u:p@localhost:5433/subcycle_dev';
  it('refuses production and remote hosts unless overridden', () => {
    expect(() => assertResetAllowed({ nodeEnv: 'production', databaseUrl: local, allowRemote: true })).toThrow(/production/);
    expect(() => assertResetAllowed({ nodeEnv: 'development', databaseUrl: 'postgres://u:p@db.example.com/x', allowRemote: false })).toThrow(/non-local/);
    expect(() => assertResetAllowed({ nodeEnv: 'development', databaseUrl: 'postgres://u:p@db.example.com/x', allowRemote: true })).not.toThrow();
    expect(() => assertResetAllowed({ nodeEnv: 'development', databaseUrl: local, allowRemote: false })).not.toThrow();
  });
});
