import { Router, type RequestHandler } from 'express';
import { subscriptionController } from '../controllers/subscriptionController';
import type { BillingDeps } from '../services/billingOperations';

/** Plans are public; everything else requires authentication. Mutations accept an optional Idempotency-Key. */
export function planRoutes(deps: BillingDeps): Router {
  const router = Router();
  router.get('/', subscriptionController(deps).plans);
  return router;
}

export function invoiceRoutes(deps: BillingDeps, authenticate: RequestHandler): Router {
  const router = Router();
  router.get('/', authenticate, subscriptionController(deps).invoices);
  return router;
}

export function subscriptionRoutes(deps: BillingDeps, authenticate: RequestHandler, idempotent: RequestHandler): Router {
  const router = Router();
  const c = subscriptionController(deps);
  router.use(authenticate);

  router.get('/current', c.current);
  router.get('/history', c.history);
  router.get('/upgrade-preview', c.upgradePreview);

  router.post('/', idempotent, c.subscribe);
  router.post('/upgrade', idempotent, c.upgrade);
  router.post('/downgrade', idempotent, c.downgrade);
  router.post('/pause', idempotent, c.pause);
  router.post('/resume', idempotent, c.resume);
  router.post('/cancel', idempotent, c.cancel);
  router.post('/reactivate', idempotent, c.reactivate);
  router.delete('/pending-change', idempotent, c.removePendingChange);
  return router;
}
