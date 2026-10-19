import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../../.env'), quiet: true });

const DEFAULT_TEST_URL = 'postgres://subcycle:subcycle_local_pw@localhost:5433/subcycle_test';

/** Test database URL. Hard-fails unless the database name ends in `_test`, so tests can never wipe dev data. */
export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_URL;
  const dbName = new URL(url).pathname.replace(/^\//, '');
  if (!dbName.endsWith('_test')) {
    throw new Error(`TEST_DATABASE_URL must point at a database whose name ends in "_test" (got "${dbName}")`);
  }
  return url;
}
