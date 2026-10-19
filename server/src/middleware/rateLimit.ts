import { rateLimit } from 'express-rate-limit';
import type { RequestHandler } from 'express';
import { tooManyRequests } from '../lib/errors';

export interface RateLimitSettings {
  windowMs: number;
  max: number;
}

/** Per-IP limiter whose rejections use the standard error shape. Each call creates an independent in-memory counter. */
export function createRateLimiter(settings: RateLimitSettings): RequestHandler {
  return rateLimit({
    windowMs: settings.windowMs,
    limit: settings.max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, _res, next) => {
      next(tooManyRequests('RATE_LIMITED', 'Too many requests, please try again later'));
    },
  });
}
