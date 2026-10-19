import { Router, type RequestHandler } from 'express';
import { authController } from '../controllers/authController';
import type { AuthDeps } from '../services/authService';

export function authRoutes(deps: AuthDeps, rateLimiter: RequestHandler, authenticate: RequestHandler): Router {
  const router = Router();
  const controller = authController(deps);
  router.use(rateLimiter); // applies to every /auth/* route
  router.post('/register', controller.register);
  router.post('/login', controller.login);
  router.get('/me', authenticate, controller.me);
  return router;
}
