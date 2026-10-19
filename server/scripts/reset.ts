import { loadConfig } from '../src/config';
import { createPool } from '../src/db/pool';
import { assertResetAllowed, resetDatabase } from '../src/db/reset';
import { seedPlans } from '../src/db/seed';

async function main(): Promise<void> {
  const config = loadConfig();
  assertResetAllowed({ nodeEnv: config.NODE_ENV, databaseUrl: config.DATABASE_URL, allowRemote: config.ALLOW_DB_RESET });
  const pool = createPool(config.DATABASE_URL);
  try {
    const { applied } = await resetDatabase(pool);
    console.log(`Schema reset. Applied: ${applied.join(', ')}`);
    const n = await seedPlans(pool);
    console.log(`Seeded ${n} plans.`);
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
