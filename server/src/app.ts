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
import { billingRoutes, demoRoutes, usageRoutes } from './routes/usage';
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
  /** Number of trusted reverse proxies in front of the API (Express `trust proxy` hop count). Default false: use the socket address. */
  trustProxy?: number | false;
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

export function createApp({ pool, clock, corsOrigins, auth, billing, usageRateLimit, jobs, dev, trustProxy }: AppDeps): Express {
  // Defence in depth: the dev routes (fake clock, run-renewals) must be impossible to mount in production,
  // whatever the caller passes in. server.ts also never passes them (config.DEV_ENDPOINTS is forced off).
  if (dev && process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to mount /dev/* routes when NODE_ENV=production');
  }
  const app = express();
  app.disable('x-powered-by');
  // req.ip (the per-IP login limiter's key) comes from X-Forwarded-For only for the hops we explicitly trust.
  if (trustProxy) app.set('trust proxy', trustProxy);
  app.use(helmet());
  app.use(
    cors({
      origin: corsOrigins, // explicit allow-list; no wildcard, no credentials (the API uses bearer tokens, not cookies)
      methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      exposedHeaders: ['Idempotent-Replay', 'RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset', 'Retry-After'],
    }),
  );
  // Responses carry personal and billing data: never let a browser or shared proxy cache them.
  app.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '100kb' }));

  const requireAuth = authenticate({ pool, clock, tokens: auth.tokens });
  const billingDeps: BillingDeps = { pool, clock, provider: billing.provider, providerTimeoutMs: billing.providerTimeoutMs };

  app.use(healthRoutes(pool, clock));
  // Per-USER limiter (runs after authentication): /auth/me, /usage, /demo. The strict per-IP one covers register and login only.
  const perUser = (settings: RateLimitSettings) => createRateLimiter(settings, (req) => req.user?.id ?? 'anonymous');
  const userLimits = usageRateLimit ?? { windowMs: 60_000, max: 600 };
  app.use('/auth', authRoutes({ pool, clock, tokens: auth.tokens, bcryptCost: auth.bcryptCost }, createRateLimiter(auth.rateLimit), requireAuth, perUser(userLimits)));
  app.use('/plans', planRoutes(billingDeps));
  app.use('/invoices', invoiceRoutes(billingDeps, requireAuth));
  app.use('/subscriptions', subscriptionRoutes(billingDeps, requireAuth, idempotency({ pool, clock })));

  // Separate from the per-plan LIMIT_EXCEEDED.
  const usageLimiter = perUser(userLimits);
  app.use('/usage', usageRoutes({ pool, clock }, requireAuth, usageLimiter));
  app.use('/demo', demoRoutes({ pool, clock }, requireAuth, usageLimiter));
  app.use('/billing', billingRoutes({ pool, clock }, requireAuth));

  if (dev) app.use('/dev', devRoutes(billingDeps, jobs ?? { reconcileAfterMs: 5 * 60_000, batchSize: 100 }, dev.fakeClock, requireAuth));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
