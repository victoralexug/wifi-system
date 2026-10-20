import type { RequestHandler } from 'express';
import { cookieAuth } from '../lib/auth';
import { HttpError } from '../lib/errors';

export const CUSTOMER_COOKIE = 'yw_customer';

declare module 'express-serve-static-core' {
  interface Request {
    customerId?: string;
  }
}

export function customerAuth(secret: string, secureCookie: boolean) {
  const auth = cookieAuth({
    secret,
    audience: 'customer',
    cookie: CUSTOMER_COOKIE,
    path: '/api',
    // Monthly bundles: stay signed in for the life of a plan.
    ttlSeconds: 30 * 24 * 60 * 60,
    // Lax, not Strict: the cookie must survive Paystack's top-level redirect back to /status.
    // Cross-site POSTs still don't carry it, and the API only accepts JSON bodies.
    sameSite: 'lax',
    secure: secureCookie,
  });

  return {
    issue: (res: Parameters<typeof auth.issue>[0], customerId: string) => auth.issue(res, customerId),
    clear: auth.clear,
    require: (async (req, _res, next) => {
      const claims = await auth.read(req);
      if (!claims) return next(new HttpError(401, 'Please sign in to continue', 'unauthenticated'));
      req.customerId = claims.sub;
      next();
    }) as RequestHandler,
  };
}
