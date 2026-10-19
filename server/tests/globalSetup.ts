import { createPool } from '../src/db/pool';
import { resetDatabase } from '../src/db/reset';
import { testDatabaseUrl } from './testEnv';

/** Runs once before all test files: drop the test schema and apply every migration from scratch. */
export default async function setup(): Promise<void> {
  const pool = createPool(testDatabaseUrl(), { max: 2 });
  try {
    await resetDatabase(pool);
  } finally {
    await pool.end();
  }
}
