import { rateLimit } from 'express-rate-limit';
import type { Request, RequestHandler } from 'express';
import { tooManyRequests } from '../lib/errors';

export interface RateLimitSettings {
  windowMs: number;
  max: number;
}

/** Per-IP limiter whose rejections use the standard error shape. Each call creates an independent in-memory counter. */
export function createRateLimiter(settings: RateLimitSettings, keyBy?: (req: Request) => string): RequestHandler {
  return rateLimit({
    windowMs: settings.windowMs,
    limit: settings.max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    ...(keyBy ? { keyGenerator: (req: Request) => keyBy(req) } : {}),
    handler: (_req, _res, next) => {
      next(tooManyRequests('RATE_LIMITED', 'Too many requests, please try again later'));
    },
  });
}
