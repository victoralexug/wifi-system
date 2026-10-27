import {
  LOW_VOUCHER_STOCK,
  type AdminCustomer,
  type AdminOrder,
  type AdminStats,
  type AdminVoucher,
  type Paginated,
  type Plan,
} from '@yourwifi/shared';
import { and, asc, count, desc, eq, gte, ilike, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { admins, customers, orders, plans, vouchers } from '../db/schema';
import type { Deps } from '../deps';
import { badRequest, HttpError, notFound } from '../lib/errors';
import { generateCode } from '../lib/ids';
import { PgRateLimitStore } from '../lib/rate-limit-store';
import { hashPassword, verifyPassword } from '../lib/password';
import { toCsv, toRouterOsScript } from '../vouchers/export';
import type { VoucherService } from '../vouchers/vouchers.service';
import { adminAuth } from './auth';

const loginBody = z.object({ email: z.email(), password: z.string().min(1).max(200) });

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  status: z.string().optional(),
  q: z.string().trim().max(100).optional(),
});

const planFields = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(200),
  priceKobo: z.number().int().min(100),
  durationMinutes: z.number().int().min(1).max(60 * 24 * 90),
  dataCapMb: z.number().int().positive().nullable(),
  active: z.boolean(),
  sortOrder: z.number().int(),
  voucherStockTarget: z.number().int().min(0).max(100_000),
});
// Defaults only when creating. Updates change just the fields sent: with defaults, a partial
// update would reset every field it left out.
const createPlanBody = planFields.extend({
  description: planFields.shape.description.default(''),
  dataCapMb: planFields.shape.dataCapMb.default(null),
  active: planFields.shape.active.default(true),
  sortOrder: planFields.shape.sortOrder.default(0),
  voucherStockTarget: planFields.shape.voucherStockTarget.default(0),
});
const updatePlanBody = planFields.partial();

const voucherListQuery = listQuery.extend({ planId: z.uuid().optional() });
const addVouchersBody = z.object({ planId: z.uuid(), codes: z.string().min(1).max(1_000_000) });

const iso = (d: Date | null) => d?.toISOString() ?? null;

/** Lets admins search "0803…" or "234803…" against phones stored as "+234803…". */
function phoneSearchTerm(q: string): string {
  const digits = q.replace(/\D/g, '');
  if (digits.length < 3) return q;
  if (digits.startsWith('234')) return digits.slice(3);
  if (digits.startsWith('0')) return digits.slice(1);
  return digits;
}

export function adminRoutes(deps: Deps, voucherService: VoucherService): Router {
  const r = Router();
  const { db, config } = deps;
  const auth = adminAuth(config.ADMIN_JWT_SECRET, config.isProd);

  r.post(
    '/login',
    rateLimit({ store: new PgRateLimitStore(db, 'admin-login:'), windowMs: 15 * 60_000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false }),
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
    const stock = await voucherService.stock();
    const body: AdminStats = {
      revenueKobo: {
        today: await revenueSince(lagosMidnight),
        last7Days: await revenueSince(new Date(lagosMidnight.getTime() - 6 * day)),
        last30Days: await revenueSince(new Date(lagosMidnight.getTime() - 29 * day)),
      },
      orders: { pending: oc.pending ?? 0, success: oc.success ?? 0, failed: oc.failed ?? 0, flagged: oc.flagged ?? 0 },
      ordersWaitingForVoucher: stock.reduce((n, s) => n + s.waitingOrders, 0),
      lowVoucherStock: stock
        .filter((s) => s.active && s.available < LOW_VOUCHER_STOCK)
        .map(({ planId, planName, available }) => ({ planId, planName, available })),
      dailyRevenue,
    };
    res.json(body);
  });

  r.get('/orders', async (req, res) => {
    const q = listQuery.parse(req.query);
    const filters: SQL[] = [];
    if (q.status) filters.push(eq(orders.status, q.status as AdminOrder['status']));
    if (q.q) {
      filters.push(
        or(
          ilike(orders.reference, `%${q.q}%`),
          ilike(customers.phone, `%${phoneSearchTerm(q.q)}%`),
          ilike(vouchers.code, `%${q.q}%`),
        )!,
      );
    }
    const where = filters.length ? and(...filters) : undefined;

    const base = db
      .select({ o: orders, phone: customers.phone, planName: plans.name, voucherCode: vouchers.code })
      .from(orders)
      .innerJoin(customers, eq(customers.id, orders.customerId))
      .innerJoin(plans, eq(plans.id, orders.planId))
      .leftJoin(vouchers, eq(vouchers.orderId, orders.id))
      .where(where);
    const rows = await base.orderBy(desc(orders.createdAt)).limit(q.pageSize).offset((q.page - 1) * q.pageSize);
    const [total] = await db
      .select({ n: count() })
      .from(orders)
      .innerJoin(customers, eq(customers.id, orders.customerId))
      .leftJoin(vouchers, eq(vouchers.orderId, orders.id))
      .where(where);

    const body: Paginated<AdminOrder> = {
      items: rows.map(({ o, phone, planName, voucherCode }) => ({
        id: o.id,
        reference: o.reference,
        status: o.status,
        amountKobo: o.amountKobo,
        phone,
        email: o.email,
        planName,
        voucherCode,
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

    const rows = await db
      .select({ c: customers, orders: orderCount, spent })
      .from(customers)
      .where(where)
      .orderBy(desc(customers.createdAt))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize);
    const [total] = await db.select({ n: count() }).from(customers).where(where);

    const body: Paginated<AdminCustomer> = {
      items: rows.map(({ c, orders: n, spent: kobo }) => ({
        id: c.id,
        phone: c.phone,
        name: c.name,
        email: c.email,
        hasPassword: c.passwordHash !== null,
        orders: n,
        spentKobo: kobo,
        createdAt: c.createdAt.toISOString(),
      })),
      total: total?.n ?? 0,
      page: q.page,
      pageSize: q.pageSize,
    };
    res.json(body);
  });

  // Fallback for customers who can't use the emailed reset link (no email on file, or no access to it).
  // The admin reads this one-time password to them; they can change it from their account page.
  r.post('/customers/:id/reset-password', async (req, res) => {
    const temporaryPassword = generateCode(10);
    const [c] = await db
      .update(customers)
      .set({ passwordHash: await hashPassword(temporaryPassword) })
      .where(eq(customers.id, String(req.params.id)))
      .returning({ id: customers.id });
    if (!c) throw notFound('Customer not found');
    deps.logger.info({ customerId: c.id, admin: req.admin?.email }, 'customer password reset by admin');
    res.json({ temporaryPassword });
  });

  const toPlan = (p: typeof plans.$inferSelect, available: Map<string, number>): Plan => ({
    ...p,
    vouchersAvailable: available.get(p.id) ?? 0,
    soldOut: !available.get(p.id),
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  });

  r.get('/plans', async (_req, res) => {
    const rows = await db.select().from(plans).orderBy(asc(plans.sortOrder), asc(plans.priceKobo));
    const available = await voucherService.availableByPlan();
    res.json(rows.map((p) => toPlan(p, available)));
  });

  r.post('/plans', async (req, res) => {
    const body = createPlanBody.parse(req.body);
    const [p] = await db.insert(plans).values(body).returning();
    res.status(201).json(toPlan(p!, new Map()));
  });

  // Plans are never deleted, because past orders reference them. Set active=false instead.
  r.patch('/plans/:id', async (req, res) => {
    const body = updatePlanBody.parse(req.body);
    const [p] = await db.update(plans).set(body).where(eq(plans.id, req.params.id)).returning();
    if (!p) throw notFound('Plan not found');
    res.json(toPlan(p, await voucherService.availableByPlan()));
  });

  // ---------- vouchers ----------

  r.get('/vouchers/stock', async (_req, res) => {
    res.json(await voucherService.stock());
  });

  r.get('/vouchers/batches', async (_req, res) => {
    res.json(await voucherService.batches());
  });

  // Tops every plan up to its stock target now, instead of waiting for the monthly run.
  r.post('/vouchers/batches', async (req, res) => {
    const batch = await voucherService.generate();
    deps.logger.info({ batch, admin: req.admin?.email }, 'voucher batch requested');
    res.status(batch ? 201 : 200).json({ batch });
  });

  r.get('/vouchers/batches/:id/export', async (req, res) => {
    const id = z.uuid().safeParse(req.params.id).data;
    const format = req.query.format === 'csv' ? 'csv' : 'rsc';
    const rows = id ? await voucherService.batchCodes([id]) : [];
    if (!rows.length) throw notFound('Batch not found');
    const name = `yourwifi-vouchers-${id!.slice(0, 8)}.${format}`;
    res.attachment(name).type('text/plain');
    res.send(format === 'csv' ? toCsv(rows) : toRouterOsScript(rows, { generatedAt: deps.now() }));
  });

  // After importing a downloaded batch on the router: its codes go on sale.
  r.post('/vouchers/batches/:id/ready', async (req, res) => {
    const id = z.uuid().safeParse(req.params.id).data;
    if (!id || !(await voucherService.markReady(id, req.admin!.email))) {
      throw notFound('No batch waiting for the router with that id');
    }
    res.sendStatus(204);
  });

  r.get('/vouchers', async (req, res) => {
    const q = voucherListQuery.parse(req.query);
    const filters: SQL[] = [];
    if (q.planId) filters.push(eq(vouchers.planId, q.planId));
    if (q.status === 'available') filters.push(isNull(vouchers.orderId));
    if (q.status === 'used') filters.push(isNotNull(vouchers.orderId));
    if (q.q) filters.push(or(ilike(vouchers.code, `%${q.q}%`), ilike(orders.reference, `%${q.q}%`))!);
    const where = filters.length ? and(...filters) : undefined;

    const rows = await db
      .select({ v: vouchers, planName: plans.name, reference: orders.reference, phone: customers.phone })
      .from(vouchers)
      .innerJoin(plans, eq(plans.id, vouchers.planId))
      .leftJoin(orders, eq(orders.id, vouchers.orderId))
      .leftJoin(customers, eq(customers.id, orders.customerId))
      .where(where)
      .orderBy(desc(vouchers.assignedAt), desc(vouchers.createdAt))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize);
    const [total] = await db
      .select({ n: count() })
      .from(vouchers)
      .leftJoin(orders, eq(orders.id, vouchers.orderId))
      .where(where);

    const body: Paginated<AdminVoucher> = {
      items: rows.map(({ v, planName, reference, phone }) => ({
        id: v.id,
        code: v.code,
        planId: v.planId,
        planName,
        status: v.orderId ? 'used' : 'available',
        orderReference: reference,
        phone,
        assignedAt: iso(v.assignedAt),
        createdAt: v.createdAt.toISOString(),
      })),
      total: total?.n ?? 0,
      page: q.page,
      pageSize: q.pageSize,
    };
    res.json(body);
  });

  r.post('/vouchers', async (req, res) => {
    const body = addVouchersBody.parse(req.body);
    const [plan] = await db.select({ id: plans.id }).from(plans).where(eq(plans.id, body.planId));
    if (!plan) throw notFound('Plan not found');
    const result = await voucherService.add(body.planId, body.codes);
    deps.logger.info({ planId: body.planId, added: result.added, admin: req.admin?.email }, 'vouchers added');
    res.status(201).json(result);
  });

  // Only unused codes can be deleted: a given code is part of a customer's purchase.
  r.delete('/vouchers/:id', async (req, res) => {
    const [v] = await db.select().from(vouchers).where(eq(vouchers.id, String(req.params.id)));
    if (!v) throw notFound('Voucher not found');
    if (v.orderId) throw badRequest("This code was already given to a customer, so it can't be deleted");
    await db.delete(vouchers).where(and(eq(vouchers.id, v.id), isNull(vouchers.orderId)));
    res.sendStatus(204);
  });


  return r;
}
