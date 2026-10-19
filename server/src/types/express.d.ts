import type { PublicUser } from '../services/authService';

declare global {
  namespace Express {
    interface Request {
      /** Set by the authenticate middleware. */
      user?: PublicUser;
    }
  }
}
