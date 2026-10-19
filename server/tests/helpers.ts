import { MockProvider } from '../src/billing/mockProvider';
import { createPool, type Pool } from '../src/db/pool';
import { seedPlans } from '../src/db/seed';
import { testDatabaseUrl } from './testEnv';

export function createTestPool(): Pool {
  return createPool(testDatabaseUrl(), { max: 5 });
}

const DATA_TABLES = [
  'idempotency_keys',
  'usage_records',
  'subscription_events',
  'billing_operations',
  'invoices',
  'subscriptions',
  'plans',
  'users',
];

/** Empties every data table (not schema_migrations) between tests. */
export async function truncateAll(pool: Pool): Promise<void> {
  await pool.query(`TRUNCATE ${DATA_TABLES.join(', ')} RESTART IDENTITY CASCADE`);
}

export async function resetData(pool: Pool, opts: { seed?: boolean } = {}): Promise<void> {
  await truncateAll(pool);
  if (opts.seed !== false) await seedPlans(pool);
}

export async function insertUser(pool: Pool, email = 'user@example.com'): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, name) VALUES ($1, 'x', 'Test User') RETURNING id`,
    [email],
  );
  return rows[0]!.id;
}

export async function planId(pool: Pool, code: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM plans WHERE code = $1', [code]);
  if (!rows[0]) throw new Error(`plan ${code} not seeded`);
  return rows[0].id;
}

export interface SubOverrides {
  status?: string;
  start?: string;
  end?: string;
  extra?: Record<string, unknown>;
}

/** Inserts an active subscription by default; `extra` columns override/add (column names are trusted test input). */
export async function insertSubscription(pool: Pool, userId: string, plan: string, o: SubOverrides = {}): Promise<string> {
  const base: Record<string, unknown> = {
    user_id: userId,
    plan_id: await planId(pool, plan),
    status: o.status ?? 'active',
    current_period_start: o.start ?? '2026-01-01T00:00:00Z',
    current_period_end: o.end ?? '2026-02-01T00:00:00Z',
    ...o.extra,
  };
  const cols = Object.keys(base);
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO subscriptions (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    Object.values(base),
  );
  return rows[0]!.id;
}

/** Fast, deterministic auth settings for tests (bcrypt cost 4; generous rate limit unless overridden). */
export function testAuthSettings(overrides: { ttlSeconds?: number; max?: number; secret?: string } = {}) {
  return {
    tokens: { secret: overrides.secret ?? 'test-secret-test-secret-test-secret-123456', ttlSeconds: overrides.ttlSeconds ?? 3600 },
    bcryptCost: 4,
    rateLimit: { windowMs: 60_000, max: overrides.max ?? 1000 },
  };
}

/** Billing deps for createApp in tests; pass your own MockProvider to script failures. */
export function testBilling(provider: MockProvider = new MockProvider(), providerTimeoutMs = 5000) {
  return { provider, providerTimeoutMs };
}
