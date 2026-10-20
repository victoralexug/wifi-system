import type { RequestHandler, Response } from 'express';
import { cookieAuth } from '../lib/auth';
import { HttpError } from '../lib/errors';

export const ADMIN_COOKIE = 'yw_admin';

export interface AdminClaims {
  sub: string;
  email: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    admin?: AdminClaims;
  }
}

export function adminAuth(secret: string, secureCookie: boolean) {
  const auth = cookieAuth({
    secret,
    audience: 'admin',
    cookie: ADMIN_COOKIE,
    path: '/api/admin',
    ttlSeconds: 12 * 60 * 60,
    // Strict SameSite plus JSON-only bodies is our CSRF defence.
    sameSite: 'strict',
    secure: secureCookie,
  });

  return {
    issue: (res: Response, claims: AdminClaims) => auth.issue(res, claims.sub, { email: claims.email }),
    clear: auth.clear,
    require: (async (req, _res, next) => {
      const claims = await auth.read(req);
      if (!claims) return next(new HttpError(401, 'Not signed in', 'unauthenticated'));
      req.admin = { sub: claims.sub, email: String(claims.email) };
      next();
    }) as RequestHandler,
  };
}
