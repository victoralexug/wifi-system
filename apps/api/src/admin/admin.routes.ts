import type {
  AdminCustomer,
  AdminOrder,
  AdminSession,
  AdminStats,
  NetworkDeviceView,
  Paginated,
  Plan,
} from '@yourwifi/shared';
import { and, asc, count, desc, eq, gte, ilike, or, sql, type SQL } from 'drizzle-orm';
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { accessSessions, admins, customers, networkDevices, orders, plans } from '../db/schema';
import type { Deps } from '../deps';
import { HttpError, notFound } from '../lib/errors';
import { generateVoucherCode } from '../lib/ids';
import { hashPassword, verifyPassword } from '../lib/password';
import type { SessionService } from '../sessions/sessions.service';
import { adminAuth } from './auth';

const loginBody = z.object({ email: z.email(), password: z.string().min(1).max(200) });

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  status: z.string().optional(),
  q: z.string().trim().max(100).optional(),
});

const rateLimitPattern = /^\d+[kKmMgG]?\/\d+[kKmMgG]?$/;
const planBody = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(200).default(''),
  priceKobo: z.number().int().min(100),
  durationMinutes: z.number().int().min(1).max(60 * 24 * 90),
  rateLimit: z.string().regex(rateLimitPattern, 'Use RouterOS syntax, e.g. 5M/5M').nullable().default(null),
  dataCapMb: z.number().int().positive().nullable().default(null),
  active: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
});

const iso = (d: Date | null) => d?.toISOString() ?? null;

/** Lets admins search "0803…" or "234803…" against phones stored as "+234803…". */
function phoneSearchTerm(q: string): string {
  const digits = q.replace(/\D/g, '');
  if (digits.length < 3) return q;
  if (digits.startsWith('234')) return digits.slice(3);
  if (digits.startsWith('0')) return digits.slice(1);
  return digits;
}

export function adminRoutes(deps: Deps, sessions: SessionService): Router {
  const r = Router();
  const { db, config } = deps;
  const auth = adminAuth(config.ADMIN_JWT_SECRET, config.isProd);

  r.post(
    '/login',
    rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false }),
    async (req, res) => {
      const { email, password } = loginBody.parse(req.body);
      const [admin] = await db.select().from(admins).where(eq(admins.email, email.toLowerCase()));
      if (!admin || !(await verifyPassword(password, admin.passwordHash))) {
        throw new HttpError(401, 'Wrong email or password', 'invalid_credentials');
      }
      await auth.issue(res, { sub: admin.id, email: admin.email });
      res.json({ email: admin.email });
    },
  );

  r.post('/logout', (_req, res) => {
    auth.clear(res);
    res.sendStatus(204);
  });

  r.use(auth.require);

  r.get('/me', (req, res) => {
    res.json({ email: req.admin!.email });
  });

  r.get('/stats', async (_req, res) => {
    const now = deps.now().getTime();
    const day = 24 * 60 * 60_000;
    // Africa/Lagos is UTC+1 all year (no DST), so a fixed offset gives correct local days.
    const lagosMidnight = new Date(Math.floor((now + 3600_000) / day) * day - 3600_000);

    const revenueSince = async (since: Date) => {
      const [row] = await db
        .select({ total: sql<number>`coalesce(sum(${orders.amountKobo}), 0)::int` })
        .from(orders)
        .where(and(eq(orders.status, 'success'), gte(orders.paidAt, since)));
      return row?.total ?? 0;
    };

    const statusCounts = await db
      .select({ status: orders.status, n: count() })
      .from(orders)
      .groupBy(orders.status);
    const sessionCounts = await db
      .select({ status: accessSessions.status, n: count() })
      .from(accessSessions)
      .groupBy(accessSessions.status);

    const localDay = sql<string>`to_char((${orders.paidAt} at time zone 'UTC') + interval '1 hour', 'YYYY-MM-DD')`;
    const daily = await db
      .select({
        date: localDay,
        revenueKobo: sql<number>`sum(${orders.amountKobo})::int`,
        orders: count(),
      })
      .from(orders)
      .where(and(eq(orders.status, 'success'), gte(orders.paidAt, new Date(lagosMidnight.getTime() - 13 * day))))
      .groupBy(localDay)
      .orderBy(localDay);

    // Fill in days with no sales so the series is continuous.
    const byDate = new Map(daily.map((d) => [d.date, d]));
    const dailyRevenue = Array.from({ length: 14 }, (_, i) => {
      const date = new Date(lagosMidnight.getTime() + 3600_000 - (13 - i) * day).toISOString().slice(0, 10);
      const d = byDate.get(date);
      return { date, revenueKobo: d?.revenueKobo ?? 0, orders: d?.orders ?? 0 };
    });

    const oc = Object.fromEntries(statusCounts.map((s) => [s.status, s.n]));
    const sc = Object.fromEntries(sessionCounts.map((s) => [s.status, s.n]));
    const body: AdminStats = {
      revenueKobo: {
        today: await revenueSince(lagosMidnight),
        last7Days: await revenueSince(new Date(lagosMidnight.getTime() - 6 * day)),
        last30Days: await revenueSince(new Date(lagosMidnight.getTime() - 29 * day)),
      },
      orders: { pending: oc.pending ?? 0, success: oc.success ?? 0, failed: oc.failed ?? 0, flagged: oc.flagged ?? 0 },
      activeSessions: sc.active ?? 0,
      pendingProvisioning: sc.pending ?? 0,
      dailyRevenue,
    };
    res.json(body);
  });

  r.get('/orders', async (req, res) => {
    const q = listQuery.parse(req.query);
    const filters: SQL[] = [];
    if (q.status) filters.push(eq(orders.status, q.status as AdminOrder['status']));
    if (q.q) filters.push(or(ilike(orders.reference, `%${q.q}%`), ilike(customers.phone, `%${phoneSearchTerm(q.q)}%`))!);
    const where = filters.length ? and(...filters) : undefined;

    const base = db
      .select({ o: orders, phone: customers.phone, planName: plans.name })
      .from(orders)
      .innerJoin(customers, eq(customers.id, orders.customerId))
      .innerJoin(plans, eq(plans.id, orders.planId))
      .where(where);
    const rows = await base.orderBy(desc(orders.createdAt)).limit(q.pageSize).offset((q.page - 1) * q.pageSize);
    const [total] = await db
      .select({ n: count() })
      .from(orders)
      .innerJoin(customers, eq(customers.id, orders.customerId))
      .where(where);

    const body: Paginated<AdminOrder> = {
      items: rows.map(({ o, phone, planName }) => ({
        id: o.id,
        reference: o.reference,
        status: o.status,
        amountKobo: o.amountKobo,
        phone,
        email: o.email,
        planName,
        deviceMac: o.deviceMac,
        failureReason: o.failureReason,
        paidAt: iso(o.paidAt),
        createdAt: o.createdAt.toISOString(),
      })),
      total: total?.n ?? 0,
      page: q.page,
      pageSize: q.pageSize,
    };
    res.json(body);
  });

  r.get('/sessions', async (req, res) => {
    const q = listQuery.parse(req.query);
    const filters: SQL[] = [];
    if (q.status) filters.push(eq(accessSessions.status, q.status as AdminSession['status']));
    if (q.q) {
      filters.push(
        or(
          ilike(accessSessions.voucherCode, `%${q.q}%`),
          ilike(customers.phone, `%${phoneSearchTerm(q.q)}%`),
          ilike(orders.reference, `%${q.q}%`),
        )!,
      );
    }
    const where = filters.length ? and(...filters) : undefined;

    const rows = await db
      .select({ s: accessSessions, phone: customers.phone, reference: orders.reference })
      .from(accessSessions)
      .innerJoin(customers, eq(customers.id, accessSessions.customerId))
      .innerJoin(orders, eq(orders.id, accessSessions.orderId))
      .where(where)
      .orderBy(desc(accessSessions.createdAt))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize);
    const [total] = await db
      .select({ n: count() })
      .from(accessSessions)
      .innerJoin(customers, eq(customers.id, accessSessions.customerId))
      .innerJoin(orders, eq(orders.id, accessSessions.orderId))
      .where(where);

    const body: Paginated<AdminSession> = {
      items: rows.map(({ s, phone, reference }) => ({
        id: s.id,
        voucherCode: s.voucherCode,
        status: s.status,
        phone,
        planName: s.planName,
        orderReference: reference,
        startsAt: iso(s.startsAt),
        expiresAt: iso(s.expiresAt),
        dataCapMb: s.dataCapMb,
        bytesUsed: s.bytesUsed,
        provisionAttempts: s.provisionAttempts,
        lastError: s.lastError,
        createdAt: s.createdAt.toISOString(),
      })),
      total: total?.n ?? 0,
      page: q.page,
      pageSize: q.pageSize,
    };
    res.json(body);
  });

  r.post('/sessions/:id/revoke', async (req, res) => {
    try {
      const s = await sessions.revoke(req.params.id);
      if (!s) throw notFound('Session not found');
      res.json({ status: s.status });
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(502, `Controller error: ${(err as Error).message}`, 'controller_error');
    }
  });

  r.post('/sessions/:id/retry', async (req, res) => {
    const s = await sessions.retry(req.params.id);
    if (!s) throw notFound('Session not found');
    res.json({ status: s.status, lastError: s.lastError });
  });

  r.get('/customers', async (req, res) => {
    const q = listQuery.parse(req.query);
    const where = q.q
      ? or(
          ilike(customers.phone, `%${phoneSearchTerm(q.q)}%`),
          ilike(customers.name, `%${q.q}%`),
          ilike(customers.email, `%${q.q}%`),
        )
      : undefined;
    // Correlated subqueries spell out table names: Drizzle leaves columns unqualified inside sql``,
    // which would make "id" resolve to the inner table.
    const orderCount = sql<number>`(select count(*)::int from orders o where o.customer_id = customers.id and o.status = 'success')`;
    const spent = sql<number>`(select coalesce(sum(o.amount_kobo), 0)::int from orders o where o.customer_id = customers.id and o.status = 'success')`;
    const active = sql<number>`(select count(*)::int from access_sessions s where s.customer_id = customers.id and s.status = 'active')`;

    const rows = await db
      .select({ c: customers, orders: orderCount, spent, active })
      .from(customers)
      .where(where)
      .orderBy(desc(customers.createdAt))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize);
    const [total] = await db.select({ n: count() }).from(customers).where(where);

    const body: Paginated<AdminCustomer> = {
      items: rows.map(({ c, orders: n, spent: kobo, active: a }) => ({
        id: c.id,
        phone: c.phone,
        name: c.name,
        email: c.email,
        hasPassword: c.passwordHash !== null,
        orders: n,
        spentKobo: kobo,
        activeSessions: a,
        createdAt: c.createdAt.toISOString(),
      })),
      total: total?.n ?? 0,
      page: q.page,
      pageSize: q.pageSize,
    };
    res.json(body);
  });

  // There's no SMS or email reset, so a customer who forgets their password calls support.
  // The admin reads this one-time password to them; they can change it from their account page.
  r.post('/customers/:id/reset-password', async (req, res) => {
    const temporaryPassword = generateVoucherCode(10);
    const [c] = await db
      .update(customers)
      .set({ passwordHash: await hashPassword(temporaryPassword) })
      .where(eq(customers.id, String(req.params.id)))
      .returning({ id: customers.id });
    if (!c) throw notFound('Customer not found');
    deps.logger.info({ customerId: c.id, admin: req.admin?.email }, 'customer password reset by admin');
    res.json({ temporaryPassword });
  });

  const toPlan = (p: typeof plans.$inferSelect): Plan => ({
    ...p,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  });

  r.get('/plans', async (_req, res) => {
    const rows = await db.select().from(plans).orderBy(asc(plans.sortOrder), asc(plans.priceKobo));
    res.json(rows.map(toPlan));
  });

  r.post('/plans', async (req, res) => {
    const body = planBody.parse(req.body);
    const [p] = await db.insert(plans).values(body).returning();
    res.status(201).json(toPlan(p!));
  });

  // Plans are never deleted, because past orders reference them. Set active=false instead.
  r.patch('/plans/:id', async (req, res) => {
    const body = planBody.partial().parse(req.body);
    const [p] = await db.update(plans).set(body).where(eq(plans.id, req.params.id)).returning();
    if (!p) throw notFound('Plan not found');
    res.json(toPlan(p));
  });

  r.get('/network', async (_req, res) => {
    const devices = await db.select().from(networkDevices).orderBy(asc(networkDevices.name));
    let active: Awaited<ReturnType<typeof deps.network.listActive>> = [];
    let activeError: string | null = null;
    try {
      active = await deps.network.listActive();
    } catch (err) {
      activeError = (err as Error).message;
    }
    const views: NetworkDeviceView[] = devices.map((d) => ({
      id: d.id,
      name: d.name,
      driver: d.driver,
      status: d.status,
      identity: d.identity,
      lastSeenAt: iso(d.lastSeenAt),
      lastError: d.lastError,
    }));
    res.json({ devices: views, active, activeError });
  });

  return r;
}
