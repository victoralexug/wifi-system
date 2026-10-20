import type { AccountSession, CustomerProfile } from '@yourwifi/shared';
import { desc, eq } from 'drizzle-orm';
import { Router, type Request } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { accessSessions, customers, orders } from '../db/schema';
import type { Deps } from '../deps';
import { badRequest, HttpError } from '../lib/errors';
import { normalizeNigerianPhone } from '../lib/ids';
import { hashPassword, verifyPassword } from '../lib/password';
import { toSessionView } from '../sessions/views';
import type { customerAuth } from './customer.auth';

const password = z.string().min(8, 'Password must be at least 8 characters').max(200);

const registerBody = z.object({
  phone: z.string().min(7).max(20),
  password,
  name: z.string().trim().max(80).optional(),
  email: z.email().max(200).optional(),
});
const loginBody = z.object({ phone: z.string().min(7).max(20), password: z.string().min(1).max(200) });
const changePasswordBody = z.object({ currentPassword: z.string().min(1).max(200), newPassword: password });

const toProfile = (c: typeof customers.$inferSelect): CustomerProfile => ({
  id: c.id,
  phone: c.phone,
  name: c.name,
  email: c.email,
});

function requirePhone(input: string): string {
  const phone = normalizeNigerianPhone(input);
  if (!phone) throw badRequest('Enter a valid Nigerian phone number');
  return phone;
}

/**
 * Slows down password guessing. Only failed attempts count, so normal sign-ins never lock anyone out.
 * Keyed per account rather than per IP: everyone behind one Starlink dish shares an IP.
 */
const failedAttemptLimiter = (keyGenerator: (req: Request) => string) =>
  rateLimit({
    windowMs: 15 * 60_000,
    limit: 10,
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator,
    message: { error: { code: 'rate_limited', message: 'Too many attempts. Wait 15 minutes and try again.' } },
  });

export function customerRoutes(deps: Deps, auth: ReturnType<typeof customerAuth>): Router {
  const r = Router();
  const { db } = deps;
  const perPhoneLimiter = failedAttemptLimiter(
    (req) => `phone:${normalizeNigerianPhone(String(req.body?.phone ?? '')) ?? 'invalid'}`,
  );
  const perCustomerLimiter = failedAttemptLimiter((req) => `customer:${req.customerId}`);

  r.post('/auth/register', perPhoneLimiter, async (req, res) => {
    const body = registerBody.parse(req.body);
    const phone = requirePhone(body.phone);
    const passwordHash = await hashPassword(body.password);

    const [existing] = await db.select().from(customers).where(eq(customers.phone, phone));
    if (existing?.passwordHash) {
      throw new HttpError(409, 'An account with this phone number already exists. Sign in instead.', 'account_exists');
    }
    // A customer row without a password predates accounts (or was made by an admin); registering claims it.
    const [customer] = existing
      ? await db
          .update(customers)
          .set({ passwordHash, name: body.name ?? existing.name, email: body.email ?? existing.email })
          .where(eq(customers.id, existing.id))
          .returning()
      : await db
          .insert(customers)
          .values({ phone, passwordHash, name: body.name ?? null, email: body.email ?? null })
          .returning();

    await auth.issue(res, customer!.id);
    res.status(201).json(toProfile(customer!));
  });

  r.post('/auth/login', perPhoneLimiter, async (req, res) => {
    const body = loginBody.parse(req.body);
    const phone = normalizeNigerianPhone(body.phone);
    const [customer] = phone ? await db.select().from(customers).where(eq(customers.phone, phone)) : [];
    // Same message whether the phone or the password is wrong.
    if (!customer?.passwordHash || !(await verifyPassword(body.password, customer.passwordHash))) {
      throw new HttpError(401, 'Wrong phone number or password', 'invalid_credentials');
    }
    await auth.issue(res, customer.id);
    res.json(toProfile(customer));
  });

  r.post('/auth/logout', (_req, res) => {
    auth.clear(res);
    res.sendStatus(204);
  });

  r.get('/me', auth.require, async (req, res) => {
    const [customer] = await db.select().from(customers).where(eq(customers.id, req.customerId!));
    if (!customer) {
      auth.clear(res);
      throw new HttpError(401, 'Please sign in to continue', 'unauthenticated');
    }
    res.json(toProfile(customer));
  });

  r.get('/me/sessions', auth.require, async (req, res) => {
    const rows = await db
      .select({ s: accessSessions, reference: orders.reference, amountKobo: orders.amountKobo })
      .from(accessSessions)
      .innerJoin(orders, eq(orders.id, accessSessions.orderId))
      .where(eq(accessSessions.customerId, req.customerId!))
      .orderBy(desc(accessSessions.createdAt))
      .limit(50);
    const body: AccountSession[] = rows.map(({ s, reference, amountKobo }) => ({
      ...toSessionView(s),
      id: s.id,
      orderReference: reference,
      amountKobo,
      createdAt: s.createdAt.toISOString(),
    }));
    res.json(body);
  });

  r.post('/me/password', auth.require, perCustomerLimiter, async (req, res) => {
    const body = changePasswordBody.parse(req.body);
    const [customer] = await db.select().from(customers).where(eq(customers.id, req.customerId!));
    if (!customer?.passwordHash || !(await verifyPassword(body.currentPassword, customer.passwordHash))) {
      throw new HttpError(400, 'Your current password is incorrect', 'invalid_credentials');
    }
    await db
      .update(customers)
      .set({ passwordHash: await hashPassword(body.newPassword) })
      .where(eq(customers.id, customer.id));
    res.sendStatus(204);
  });

  return r;
}
