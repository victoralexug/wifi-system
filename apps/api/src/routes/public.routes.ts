import type { PublicPlan } from '@yourwifi/shared';
import { asc, eq } from 'drizzle-orm';
import { Router, type RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { plans } from '../db/schema';
import type { Deps } from '../deps';
import type { OrderService } from '../orders/orders.service';
import type { VoucherService } from '../vouchers/vouchers.service';

// Every customer behind one Starlink dish shares a single public (CGNAT) IP, so per-IP
// limits must be generous. They stop scripted abuse, not normal traffic.
const limiter = (limit: number) =>
  rateLimit({ windowMs: 60_000, limit, standardHeaders: 'draft-8', legacyHeaders: false });

const createOrderBody = z.object({ planId: z.uuid() });

export function publicRoutes(
  deps: Deps,
  orderService: OrderService,
  vouchers: VoucherService,
  requireCustomer: RequestHandler,
): Router {
  const r = Router();
  const { db } = deps;

  r.get('/health', async (_req, res) => {
    res.json({ ok: true, payments: deps.payments.name });
  });

  r.get('/plans', async (_req, res) => {
    const rows = await db
      .select()
      .from(plans)
      .where(eq(plans.active, true))
      .orderBy(asc(plans.sortOrder), asc(plans.priceKobo));
    const available = await vouchers.availableByPlan();
    const body: PublicPlan[] = rows.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      priceKobo: p.priceKobo,
      durationMinutes: p.durationMinutes,
      dataCapMb: p.dataCapMb,
      soldOut: !available.get(p.id),
    }));
    res.json(body);
  });

  // Buying needs an account, so customers can sign in later to see what they bought.
  r.post('/orders', limiter(60), requireCustomer, async (req, res) => {
    const body = createOrderBody.parse(req.body);
    res.status(201).json(await orderService.create({ ...body, customerId: req.customerId! }));
  });

  r.get('/orders/:reference', limiter(240), requireCustomer, async (req, res) => {
    res.json(await orderService.getStatus(String(req.params.reference), req.customerId));
  });

  // "Check my payment": asks the provider directly when the redirect or webhook didn't arrive.
  r.post('/orders/:reference/verify', limiter(60), requireCustomer, async (req, res) => {
    const reference = String(req.params.reference);
    await orderService.getStatus(reference, req.customerId); // 404s unless it's this customer's order
    await orderService.confirmPayment(reference);
    res.json(await orderService.getStatus(reference, req.customerId));
  });

  return r;
}
