import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import type { Pool } from 'pg';
import type { Clock } from './lib/clock';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { healthRoutes } from './routes/health';

export interface AppDeps {
  pool: Pool;
  clock: Clock;
  corsOrigins: string[];
}

export function createApp({ pool, clock, corsOrigins }: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: corsOrigins, methods: ['GET', 'POST', 'DELETE', 'OPTIONS'] }));
  app.use(express.json({ limit: '100kb' }));

  app.use(healthRoutes(pool, clock));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
