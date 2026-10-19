import { loadConfig } from '../src/config';
import { createPool } from '../src/db/pool';
import { runMigrations } from '../src/db/migrate';

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.DATABASE_URL);
  try {
    const { applied, skipped } = await runMigrations(pool);
    console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'No pending migrations.');
    if (skipped.length) console.log(`Already applied: ${skipped.length}`);
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
