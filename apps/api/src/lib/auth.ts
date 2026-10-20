import type { Request, Response } from 'express';
import { jwtVerify, SignJWT } from 'jose';

export interface CookieAuthOptions {
  secret: string;
  /** Tokens are only accepted by the audience they were issued for. */
  audience: 'admin' | 'customer';
  cookie: string;
  path: string;
  ttlSeconds: number;
  sameSite: 'strict' | 'lax';
  secure: boolean;
}

export interface TokenClaims {
  sub: string;
  [key: string]: unknown;
}

/** Signed-JWT session in an httpOnly cookie. Shared by admin and customer sign-in. */
export function cookieAuth(opts: CookieAuthOptions) {
  const key = new TextEncoder().encode(opts.secret);
  const cookieOptions = { httpOnly: true, secure: opts.secure, sameSite: opts.sameSite, path: opts.path } as const;

  return {
    async issue(res: Response, sub: string, extra: Record<string, unknown> = {}) {
      const token = await new SignJWT(extra)
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(sub)
        .setAudience(opts.audience)
        .setIssuedAt()
        .setExpirationTime(`${opts.ttlSeconds}s`)
        .sign(key);
      res.cookie(opts.cookie, token, { ...cookieOptions, maxAge: opts.ttlSeconds * 1000 });
    },

    clear(res: Response) {
      res.clearCookie(opts.cookie, cookieOptions);
    },

    /** Returns the claims, or null if the cookie is missing, expired, forged or for another audience. */
    async read(req: Request): Promise<TokenClaims | null> {
      const token = req.cookies?.[opts.cookie];
      if (!token) return null;
      try {
        const { payload } = await jwtVerify(token, key, { algorithms: ['HS256'], audience: opts.audience });
        return payload.sub ? (payload as TokenClaims) : null;
      } catch {
        return null;
      }
    },
  };
}
