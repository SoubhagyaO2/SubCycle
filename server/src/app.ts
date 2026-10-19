import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import type { Pool } from 'pg';
import type { BillingProvider } from './billing/provider';
import type { Clock, FakeClock } from './lib/clock';
import { authenticate } from './middleware/authenticate';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { idempotency } from './middleware/idempotency';
import { createRateLimiter, type RateLimitSettings } from './middleware/rateLimit';
import type { JobSettings } from './controllers/devController';
import { authRoutes } from './routes/auth';
import { devRoutes } from './routes/dev';
import { healthRoutes } from './routes/health';
import { demoRoutes, usageRoutes } from './routes/usage';
import { invoiceRoutes, planRoutes, subscriptionRoutes } from './routes/subscriptions';
import type { BillingDeps } from './services/billingOperations';
import type { TokenSettings } from './services/tokenService';

export interface AppDeps {
  pool: Pool;
  clock: Clock;
  corsOrigins: string[];
  auth: {
    tokens: TokenSettings;
    bcryptCost: number;
    rateLimit: RateLimitSettings;
  };
  /** Per-user limiter for /usage and /demo (default 600 requests per minute). */
  usageRateLimit?: RateLimitSettings;
  /** Settings for the job cycle triggered by the dev endpoint (the scheduler is wired in server.ts). */
  jobs?: JobSettings;
  /** Mount /dev/* (authenticated). Never pass this in production. `fakeClock` enables POST /dev/advance-clock. */
  dev?: { fakeClock: FakeClock | null };
  billing: {
    provider: BillingProvider;
    /** Provider calls slower than this are an UNKNOWN outcome, reconciled later (never retried with a new key). */
    providerTimeoutMs: number;
  };
}

export function createApp({ pool, clock, corsOrigins, auth, billing, usageRateLimit, jobs, dev }: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: corsOrigins, methods: ['GET', 'POST', 'DELETE', 'OPTIONS'] }));
  app.use(express.json({ limit: '100kb' }));

  const requireAuth = authenticate({ pool, clock, tokens: auth.tokens });
  const billingDeps: BillingDeps = { pool, clock, provider: billing.provider, providerTimeoutMs: billing.providerTimeoutMs };

  app.use(healthRoutes(pool, clock));
  app.use('/auth', authRoutes({ pool, clock, tokens: auth.tokens, bcryptCost: auth.bcryptCost }, createRateLimiter(auth.rateLimit), requireAuth));
  app.use('/plans', planRoutes(billingDeps));
  app.use('/invoices', invoiceRoutes(billingDeps, requireAuth));
  app.use('/subscriptions', subscriptionRoutes(billingDeps, requireAuth, idempotency({ pool, clock })));

  // Per-USER limiter (runs after authentication), separate from the per-plan LIMIT_EXCEEDED.
  const usageLimiter = createRateLimiter(usageRateLimit ?? { windowMs: 60_000, max: 600 }, (req) => req.user?.id ?? 'anonymous');
  app.use('/usage', usageRoutes({ pool, clock }, requireAuth, usageLimiter));
  app.use('/demo', demoRoutes({ pool, clock }, requireAuth, usageLimiter));

  if (dev) app.use('/dev', devRoutes(billingDeps, jobs ?? { reconcileAfterMs: 5 * 60_000, batchSize: 100 }, dev.fakeClock, requireAuth));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
