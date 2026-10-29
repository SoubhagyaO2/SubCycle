import { createApp } from './app';
import { createJobRunner, logSummary, startScheduler } from './jobs/scheduler';
import { runJobCycle } from './services/renewalService';
import { MockProvider } from './billing/mockProvider';
import { loadConfig } from './config';
import { createPool } from './db/pool';
import { FakeClock, SystemClock, type Clock } from './lib/clock';

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
const fakeClock = config.FAKE_CLOCK ? new FakeClock(new SystemClock().now()) : null;
const clock: Clock = fakeClock ?? new SystemClock();
// v1 uses the mock provider. Swap in a real BillingProvider here (see src/billing/stripeProvider.ts).
const provider = new MockProvider({ failMode: config.MOCK_BILLING_FAIL });
const jobs = { reconcileAfterMs: config.RECONCILE_AFTER_MINUTES * 60_000, batchSize: config.JOBS_BATCH_SIZE };
const app = createApp({
  pool,
  clock,
  corsOrigins: config.CORS_ORIGINS,
  trustProxy: config.TRUST_PROXY,
  auth: {
    tokens: { secret: config.JWT_SECRET, ttlSeconds: config.JWT_EXPIRES_IN_SECONDS },
    bcryptCost: config.BCRYPT_COST,
    rateLimit: { windowMs: config.AUTH_RATE_LIMIT_WINDOW_MS, max: config.AUTH_RATE_LIMIT_MAX },
  },
  usageRateLimit: { windowMs: config.USAGE_RATE_LIMIT_WINDOW_MS, max: config.USAGE_RATE_LIMIT_MAX },
  billing: { provider, providerTimeoutMs: config.BILLING_TIMEOUT_MS },
  jobs,
  ...(config.DEV_ENDPOINTS ? { dev: { fakeClock } } : {}),
});

const billingDeps = { pool, clock, provider, providerTimeoutMs: config.BILLING_TIMEOUT_MS };
const scheduler = config.RUN_JOBS
  ? startScheduler(
      config.JOBS_CRON,
      createJobRunner(() => runJobCycle(billingDeps, jobs), {
        onSummary: logSummary,
        onError: (err) => console.error('[jobs] cycle failed:', err instanceof Error ? err.message : 'unknown error'),
      }),
    )
  : null;

const server = app.listen(config.PORT, () => {
  console.log(`SubCycle API listening on port ${config.PORT} (${config.NODE_ENV})`);
});

function shutdown(signal: string): void {
  console.log(`${signal} received, shutting down`);
  scheduler?.stop();
  server.close(() => {
    pool.end().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
