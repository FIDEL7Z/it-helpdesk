import jwt from 'jsonwebtoken';
import { env } from '../config/env';

/** Data carried by the access token. The user role is always read from the database. */
export interface AccessTokenPayload {
  sub: string;
}

const ALGORITHM = 'HS256';

export function signAccessToken(userId: string): string {
  return jwt.sign({}, env.JWT_SECRET, {
    subject: userId,
    expiresIn: env.JWT_EXPIRES_IN,
    algorithm: ALGORITHM,
  });
}

/** Checks signature and expiration. Throws a jsonwebtoken error when the token is not valid. */
export function verifyAccessToken(token: string): AccessTokenPayload {
  const payload = jwt.verify(token, env.JWT_SECRET, { algorithms: [ALGORITHM] });

  if (typeof payload === 'string' || typeof payload.sub !== 'string') {
    throw new jwt.JsonWebTokenError('Invalid token payload');
  }

  return { sub: payload.sub };
}
