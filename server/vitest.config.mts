import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/globalSetup.ts'],
    // All test files share one PostgreSQL database, so run files serially (see docs/DECISIONS.md B15).
    fileParallelism: false,
    testTimeout: 60_000, // generous: heavy concurrency tests (150 requests) must not flake on a slow or busy runner
    hookTimeout: 60_000,
    env: { NODE_ENV: 'test' },
  },
});
