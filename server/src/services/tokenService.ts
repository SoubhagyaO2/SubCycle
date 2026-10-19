import jwt from 'jsonwebtoken';
import type { Clock } from '../lib/clock';
import { AppError, unauthenticated } from '../lib/errors';

export interface TokenSettings {
  secret: string;
  ttlSeconds: number;
}

export interface IssuedToken {
  token: string;
  expiresAt: Date;
}

const ALGORITHM = 'HS256';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Issues a short-lived HS256 token. Payload is only { sub, iat, exp }; times come from the injected Clock. */
export function issueToken(userId: string, settings: TokenSettings, clock: Clock): IssuedToken {
  const iat = Math.floor(clock.now().getTime() / 1000);
  const exp = iat + settings.ttlSeconds;
  const token = jwt.sign({ sub: userId, iat, exp }, settings.secret, { algorithm: ALGORITHM });
  return { token, expiresAt: new Date(exp * 1000) };
}

/** Verifies signature (algorithm pinned), expiry (against the injected Clock) and subject. Throws 401 AppErrors. */
export function verifyToken(token: string, settings: TokenSettings, clock: Clock): { userId: string } {
  let payload: string | jwt.JwtPayload;
  try {
    payload = jwt.verify(token, settings.secret, {
      algorithms: [ALGORITHM],
      clockTimestamp: Math.floor(clock.now().getTime() / 1000),
    });
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) throw new AppError(401, 'TOKEN_EXPIRED', 'Token has expired');
    throw unauthenticated('Invalid token');
  }
  const sub = typeof payload === 'object' ? payload.sub : undefined;
  if (typeof sub !== 'string' || !UUID.test(sub)) throw unauthenticated('Invalid token');
  return { userId: sub };
}
