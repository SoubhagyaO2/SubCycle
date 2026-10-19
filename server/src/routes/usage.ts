import { Router, type RequestHandler } from 'express';
import type { Pool } from 'pg';
import { demoController, usageController } from '../controllers/usageController';
import type { Clock } from '../lib/clock';
import { enforceLimit } from '../middleware/enforceLimit';

export function usageRoutes(deps: { pool: Pool; clock: Clock }, authenticate: RequestHandler, limiter: RequestHandler): Router {
  const router = Router();
  const c = usageController(deps);
  router.use(authenticate, limiter);
  router.get('/', c.get);
  router.post('/', c.record);
  return router;
}

export function demoRoutes(deps: { pool: Pool; clock: Clock }, authenticate: RequestHandler, limiter: RequestHandler): Router {
  const router = Router();
  const c = demoController(deps.clock);
  router.use(authenticate, limiter);
  // Real server-side enforcement: 402 / 429 are decided by PostgreSQL before any work, usage commits with the report.
  router.post('/generate-report', enforceLimit(deps, 'api_calls', 1), c.generateReport);
  return router;
}
