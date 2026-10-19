import { Router } from 'express';
import type { Pool } from 'pg';
import type { Clock } from '../lib/clock';
import { healthController } from '../controllers/healthController';

export function healthRoutes(pool: Pool, clock: Clock): Router {
  const router = Router();
  router.get('/health', healthController(pool, clock));
  return router;
}
