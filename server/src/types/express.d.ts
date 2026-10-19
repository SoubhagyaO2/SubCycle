import type { Meter } from '../middleware/enforceLimit';
import type { PublicUser } from '../services/authService';

declare global {
  namespace Express {
    interface Request {
      /** Set by the authenticate middleware. */
      user?: PublicUser;
      /** Set by enforceLimit: the metered transaction (usage already consumed in it). */
      meter?: Meter;
    }
  }
}
