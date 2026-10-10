import type { Request, RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { isValidObjectId } from 'mongoose';
import { can, type Permission } from '../auth/permissions';
import { HttpError } from '../errors/http-error';
import { UserModel, toPublicUser, type PublicUser, type UserRole } from '../models/user.model';
import { verifyAccessToken, type AccessTokenPayload } from '../utils/jwt';

function readBearerToken(req: Request): string {
  const [scheme, token] = req.headers.authorization?.split(' ') ?? [];

  if (scheme !== 'Bearer' || !token) {
    throw new HttpError(401, 'Authentication required');
  }

  return token;
}

function decodeToken(token: string): AccessTokenPayload {
  try {
    return verifyAccessToken(token);
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw new HttpError(401, 'Token expired');
    }
    throw new HttpError(401, 'Invalid token');
  }
}

/** Returns the user set by requireAuth. Use only in handlers that run after it. */
export function getAuthenticatedUser(req: Request): PublicUser {
  if (!req.user) {
    throw new HttpError(401, 'Authentication required');
  }
  return req.user;
}

/**
 * Validates the Bearer token (signature and expiration) and loads the user from
 * the database, so deleted users are rejected and the role is always current.
 */
export const requireAuth: RequestHandler = async (req, _res, next) => {
  const payload = decodeToken(readBearerToken(req));

  const user = isValidObjectId(payload.sub) ? await UserModel.findById(payload.sub) : null;
  if (!user || !user.active) {
    throw new HttpError(401, 'User no longer exists');
  }

  req.user = toPublicUser(user);
  next();
};

/** Must run after requireAuth. Responds 403 when the user's role lacks the permission. */
export function requirePermission(permission: Permission): RequestHandler {
  return (req, _res, next) => {
    const user = getAuthenticatedUser(req);

    if (!can(user.role, permission)) {
      throw new HttpError(403, 'You do not have permission to access this resource');
    }

    next();
  };
}

/** Must run after requireAuth. Responds 403 when the user has none of the given roles. */
export function requireRole(...roles: UserRole[]): RequestHandler {
  return (req, _res, next) => {
    const user = getAuthenticatedUser(req);

    if (!roles.includes(user.role)) {
      throw new HttpError(403, 'You do not have permission to access this resource');
    }

    next();
  };
}
