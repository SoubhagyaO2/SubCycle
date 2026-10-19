import { Router, type RequestHandler } from 'express';
import { authController } from '../controllers/authController';
import type { AuthDeps } from '../services/authService';

/**
 * `credentialLimiter` (strict, per IP) protects the endpoints an attacker can brute-force: register and login.
 * `/auth/me` is called by the frontend on every page load to validate the session, so it uses the generous per-USER
 * limiter instead; a strict per-IP cap there would lock real users out of their own session.
 */
export function authRoutes(deps: AuthDeps, credentialLimiter: RequestHandler, authenticate: RequestHandler, meLimiter: RequestHandler): Router {
  const router = Router();
  const controller = authController(deps);
  router.post('/register', credentialLimiter, controller.register);
  router.post('/login', credentialLimiter, controller.login);
  router.get('/me', authenticate, meLimiter, controller.me);
  return router;
}
