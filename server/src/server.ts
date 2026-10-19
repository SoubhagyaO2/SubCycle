import { createApp } from './app';
import { MockProvider } from './billing/mockProvider';
import { loadConfig } from './config';
import { createPool } from './db/pool';
import { FakeClock, SystemClock, type Clock } from './lib/clock';

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
const clock: Clock = config.FAKE_CLOCK ? new FakeClock(new SystemClock().now()) : new SystemClock();
const app = createApp({
  pool,
  clock,
  corsOrigins: config.CORS_ORIGINS,
  auth: {
    tokens: { secret: config.JWT_SECRET, ttlSeconds: config.JWT_EXPIRES_IN_SECONDS },
    bcryptCost: config.BCRYPT_COST,
    rateLimit: { windowMs: config.AUTH_RATE_LIMIT_WINDOW_MS, max: config.AUTH_RATE_LIMIT_MAX },
  },
  // v1 uses the mock provider. Swap in a real BillingProvider here (see src/billing/stripeProvider.ts).
  billing: { provider: new MockProvider({ failMode: config.MOCK_BILLING_FAIL }), providerTimeoutMs: config.BILLING_TIMEOUT_MS },
});

const server = app.listen(config.PORT, () => {
  console.log(`SubCycle API listening on port ${config.PORT} (${config.NODE_ENV})`);
});

function shutdown(signal: string): void {
  console.log(`${signal} received, shutting down`);
  server.close(() => {
    pool.end().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
