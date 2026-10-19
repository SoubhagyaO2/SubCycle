import { Router, type RequestHandler } from 'express';
import { devController, type JobSettings } from '../controllers/devController';
import type { FakeClock } from '../lib/clock';
import type { BillingDeps } from '../services/billingOperations';

/** Development only. app.ts mounts this ONLY when explicitly enabled, which server.ts never does in production. */
export function devRoutes(deps: BillingDeps, jobs: JobSettings, fakeClock: FakeClock | null, authenticate: RequestHandler): Router {
  const router = Router();
  const c = devController(deps, jobs, fakeClock);
  router.use(authenticate);
  router.post('/run-renewals', c.runRenewals);
  router.post('/advance-clock', c.advanceClock);
  return router;
}
