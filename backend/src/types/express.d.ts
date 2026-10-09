import type { PublicUser } from '../models/user.model';

declare global {
  namespace Express {
    interface Request {
      /** Set by the requireAuth middleware. */
      user?: PublicUser;
    }
  }
}

export {};
