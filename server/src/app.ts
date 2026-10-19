import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import type { Pool } from 'pg';
import type { Clock } from './lib/clock';
import { authenticate } from './middleware/authenticate';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { createRateLimiter, type RateLimitSettings } from './middleware/rateLimit';
import { authRoutes } from './routes/auth';
import { healthRoutes } from './routes/health';
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
}

export function createApp({ pool, clock, corsOrigins, auth }: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: corsOrigins, methods: ['GET', 'POST', 'DELETE', 'OPTIONS'] }));
  app.use(express.json({ limit: '100kb' }));

  const requireAuth = authenticate({ pool, clock, tokens: auth.tokens });

  app.use(healthRoutes(pool, clock));
  app.use('/auth', authRoutes({ pool, clock, tokens: auth.tokens, bcryptCost: auth.bcryptCost }, createRateLimiter(auth.rateLimit), requireAuth));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
