import type { RequestHandler } from 'express';
import type { Pool } from 'pg';
import type { Clock } from '../lib/clock';
import { unauthenticated } from '../lib/errors';
import { findUserById } from '../services/authService';
import { verifyToken, type TokenSettings } from '../services/tokenService';

const BEARER = /^Bearer ([A-Za-z0-9\-_=]+\.[A-Za-z0-9\-_=]+\.[A-Za-z0-9\-_=]*)$/i;

/**
 * Requires `Authorization: Bearer <jwt>`, verifies it, and loads the user (a token for a deleted user is rejected).
 * A database failure propagates as a 500, never a 401, so clients don't log out on transient errors.
 */
export function authenticate(deps: { pool: Pool; clock: Clock; tokens: TokenSettings }): RequestHandler {
  return async (req, _res, next) => {
    const header = req.headers.authorization;
    const match = header ? BEARER.exec(header) : null;
    if (!match?.[1]) throw unauthenticated();
    const { userId } = verifyToken(match[1], deps.tokens, deps.clock);
    const user = await findUserById(deps.pool, userId);
    if (!user) throw unauthenticated('Invalid token');
    req.user = user;
    next();
  };
}
