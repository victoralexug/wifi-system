import type { AccountOrder, CustomerProfile } from '@yourwifi/shared';
import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, gt, isNull, ne } from 'drizzle-orm';
import { Router, type Request } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { customers, orders, passwordResetTokens, plans, vouchers } from '../db/schema';
import type { Deps } from '../deps';
import { badRequest, HttpError } from '../lib/errors';
import { normalizeNigerianPhone } from '../lib/ids';
import { hashPassword, verifyPassword } from '../lib/password';
import type { MailMessage } from '../mail';
import type { customerAuth } from './customer.auth';

const password = z.string().min(8, 'Password must be at least 8 characters').max(200);
// Stored lowercased, so sign-up and reset requests match however the customer typed it.
const email = z.string().trim().toLowerCase().max(200).pipe(z.email('Enter a valid email address'));

const registerBody = z.object({
  phone: z.string().min(7).max(20),
  password,
  name: z.string().trim().max(80).optional(),
  email,
});
const loginBody = z.object({ phone: z.string().min(7).max(20), password: z.string().min(1).max(200) });
const changePasswordBody = z.object({ currentPassword: z.string().min(1).max(200), newPassword: password });
const changeEmailBody = z.object({ email, currentPassword: z.string().min(1).max(200) });
const forgotPasswordBody = z.object({ email });
const resetPasswordBody = z.object({ token: z.string().min(1).max(200), password });

const RESET_TOKEN_TTL_MS = 30 * 60_000;
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

const emailTaken = () => new HttpError(409, 'This email is already used by another account', 'email_taken');

/** Postgres unique violation. Drizzle wraps driver errors, so check the cause too. */
function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === '23505' || e?.cause?.code === '23505';
}

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
  // Counts every request, not just failures: each one sends an email, so this stops inbox flooding.
  const perEmailResetLimiter = rateLimit({
    windowMs: 60 * 60_000,
    limit: 5,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: (req) => `reset:${String(req.body?.email ?? '').trim().toLowerCase()}`,
    message: { error: { code: 'rate_limited', message: 'Too many reset requests. Wait an hour and try again.' } },
  });

  const emailInUse = async (address: string, exceptCustomerId?: string) => {
    const [owner] = await db.select({ id: customers.id }).from(customers).where(eq(customers.email, address));
    return !!owner && owner.id !== exceptCustomerId;
  };

  r.post('/auth/register', perPhoneLimiter, async (req, res) => {
    const body = registerBody.parse(req.body);
    const phone = requirePhone(body.phone);
    const passwordHash = await hashPassword(body.password);

    const [existing] = await db.select().from(customers).where(eq(customers.phone, phone));
    if (existing?.passwordHash) {
      throw new HttpError(409, 'An account with this phone number already exists. Sign in instead.', 'account_exists');
    }
    if (await emailInUse(body.email, existing?.id)) throw emailTaken();
    // A customer row without a password predates accounts (or was made by an admin); registering claims it.
    let customer: typeof customers.$inferSelect | undefined;
    try {
      [customer] = existing
        ? await db
            .update(customers)
            .set({ passwordHash, name: body.name ?? existing.name, email: body.email })
            .where(eq(customers.id, existing.id))
            .returning()
        : await db
            .insert(customers)
            .values({ phone, passwordHash, name: body.name ?? null, email: body.email })
            .returning();
    } catch (err) {
      // Lost a race with another sign-up using the same phone or email.
      if (isUniqueViolation(err)) {
        throw new HttpError(409, 'An account with these details already exists. Sign in instead.', 'account_exists');
      }
      throw err;
    }

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

  // Always answers 204, so the form never reveals which emails have accounts.
  r.post('/auth/forgot-password', perEmailResetLimiter, async (req, res) => {
    const body = forgotPasswordBody.parse(req.body);
    const [customer] = await db.select().from(customers).where(eq(customers.email, body.email));
    if (customer) {
      const token = randomBytes(32).toString('base64url');
      await db.insert(passwordResetTokens).values({
        customerId: customer.id,
        tokenHash: hashToken(token),
        expiresAt: new Date(deps.now().getTime() + RESET_TOKEN_TTL_MS),
      });
      // In the fragment, not the query string, so the token never reaches server or proxy logs.
      const link = new URL(`/reset-password#${token}`, deps.config.PUBLIC_PORTAL_URL).toString();
      // Not awaited: a slow mail server shouldn't hold up the response or hint that the account exists.
      deps.mail.send(resetEmail(body.email, link)).catch((err) => {
        deps.logger.error({ err, customerId: customer.id }, 'password reset email failed');
      });
    }
    res.sendStatus(204);
  });

  r.post('/auth/reset-password', async (req, res) => {
    const body = resetPasswordBody.parse(req.body);
    const now = deps.now();
    // Conditional update: a link works once, even if it's submitted twice at the same moment.
    const [used] = await db
      .update(passwordResetTokens)
      .set({ usedAt: now })
      .where(
        and(
          eq(passwordResetTokens.tokenHash, hashToken(body.token)),
          isNull(passwordResetTokens.usedAt),
          gt(passwordResetTokens.expiresAt, now),
        ),
      )
      .returning({ customerId: passwordResetTokens.customerId });
    if (!used) {
      throw new HttpError(400, 'This reset link has expired or was already used. Request a new one.', 'invalid_reset_token');
    }
    const [customer] = await db
      .update(customers)
      .set({ passwordHash: await hashPassword(body.password) })
      .where(eq(customers.id, used.customerId))
      .returning();
    // Older links sent to the same customer stop working too.
    await db
      .update(passwordResetTokens)
      .set({ usedAt: now })
      .where(and(eq(passwordResetTokens.customerId, used.customerId), isNull(passwordResetTokens.usedAt)));
    deps.logger.info({ customerId: used.customerId }, 'customer password reset by email');
    await auth.issue(res, customer!.id);
    res.json(toProfile(customer!));
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

  // Purchase history, newest first. Abandoned checkouts (still pending) are left out.
  r.get('/me/orders', auth.require, async (req, res) => {
    const rows = await db
      .select({ o: orders, planName: plans.name, voucherCode: vouchers.code })
      .from(orders)
      .innerJoin(plans, eq(plans.id, orders.planId))
      .leftJoin(vouchers, eq(vouchers.orderId, orders.id))
      .where(and(eq(orders.customerId, req.customerId!), ne(orders.status, 'pending')))
      .orderBy(desc(orders.createdAt))
      .limit(50);
    const body: AccountOrder[] = rows.map(({ o, planName, voucherCode }) => ({
      reference: o.reference,
      status: o.status,
      planName,
      amountKobo: o.amountKobo,
      voucherCode,
      paidAt: o.paidAt?.toISOString() ?? null,
      createdAt: o.createdAt.toISOString(),
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

  // Asks for the password so someone holding a signed-in phone can't redirect the reset emails.
  r.post('/me/email', auth.require, perCustomerLimiter, async (req, res) => {
    const body = changeEmailBody.parse(req.body);
    const [customer] = await db.select().from(customers).where(eq(customers.id, req.customerId!));
    if (!customer?.passwordHash || !(await verifyPassword(body.currentPassword, customer.passwordHash))) {
      throw new HttpError(400, 'Your current password is incorrect', 'invalid_credentials');
    }
    if (await emailInUse(body.email, customer.id)) throw emailTaken();
    try {
      const [updated] = await db
        .update(customers)
        .set({ email: body.email })
        .where(eq(customers.id, customer.id))
        .returning();
      res.json(toProfile(updated!));
    } catch (err) {
      if (isUniqueViolation(err)) throw emailTaken();
      throw err;
    }
  });

  return r;
}

function resetEmail(to: string, link: string): MailMessage {
  const ignore = "The link works once, for 30 minutes. If you didn't ask for this, ignore this email; your password stays the same.";
  return {
    to,
    subject: 'Reset your Wi-Fi password',
    text: `Someone asked to reset the password for your Wi-Fi account.\n\nChoose a new password here: ${link}\n\n${ignore}`,
    html:
      '<p>Someone asked to reset the password for your Wi-Fi account.</p>' +
      `<p><a href="${link}">Choose a new password</a></p>` +
      `<p>${ignore}</p>`,
  };
}
