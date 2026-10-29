import type { AddVouchersResult, VoucherBatchView, VoucherStock } from '@yourwifi/shared';
import { and, asc, count, desc, eq, gte, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Database } from '../db/client';
import { orders, plans, voucherBatches, vouchers } from '../db/schema';
import type { Deps } from '../deps';
import { badRequest } from '../lib/errors';
import { generateCode } from '../lib/ids';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

// Printable ASCII without spaces: whatever the Wi-Fi system's voucher generator produces.
const CODE = /^[\x21-\x7e]{1,64}$/;
const MAX_CODES_PER_UPLOAD = 10_000;
const GENERATED_CODE_LENGTH = 8;

/** A code can be sold once it's on the router (ready) and not yet given to an order. */
const sellable = and(isNull(vouchers.orderId), isNotNull(vouchers.readyAt));

export class VoucherService {
  constructor(private readonly deps: Pick<Deps, 'db' | 'logger' | 'now' | 'config'>) {}

  /**
   * Gives a paid order the next sellable voucher for its plan, oldest first. Returns the code, or
   * null if the plan has none left (the order then waits for assignWaiting). Safe to call repeatedly.
   */
  async assign(tx: Tx | Database, order: { id: string; planId: string }): Promise<string | null> {
    const [existing] = await tx.select({ code: vouchers.code }).from(vouchers).where(eq(vouchers.orderId, order.id));
    if (existing) return existing.code;
    const now = this.deps.now();
    // SKIP LOCKED: payments for the same plan confirmed at the same moment each take a different voucher.
    const next = tx
      .select({ id: vouchers.id })
      .from(vouchers)
      .where(and(eq(vouchers.planId, order.planId), sellable))
      .orderBy(asc(vouchers.readyAt), asc(vouchers.createdAt), asc(vouchers.id))
      .limit(1)
      .for('update', { skipLocked: true });
    const [taken] = await tx
      .update(vouchers)
      .set({
        orderId: order.id,
        assignedAt: now,
        // Valid for the plan's duration from now, whether it's used or not.
        expiresAt: sql`${now}::timestamptz + (select ${plans.durationMinutes} from ${plans} where ${plans.id} = ${order.planId}) * interval '1 minute'`,
      })
      .where(and(inArray(vouchers.id, next), isNull(vouchers.orderId)))
      .returning({ code: vouchers.code });
    return taken?.code ?? null;
  }

  /** Gives vouchers to paid orders that are still waiting for one, oldest payment first. */
  async assignWaiting(): Promise<number> {
    const { db, logger } = this.deps;
    const waiting = await db
      .select({ id: orders.id, planId: orders.planId })
      .from(orders)
      .leftJoin(vouchers, eq(vouchers.orderId, orders.id))
      .where(and(eq(orders.status, 'success'), isNull(vouchers.id)))
      .orderBy(asc(orders.paidAt))
      .limit(500);
    let assigned = 0;
    for (const o of waiting) {
      if (await db.transaction((tx) => this.assign(tx, o))) assigned++;
    }
    if (assigned) logger.info({ assigned }, 'vouchers given to waiting orders');
    return assigned;
  }

  /**
   * Adds codes for a plan from pasted text (one per line, or separated by commas or spaces).
   * Uploaded codes come from the router, so they can be sold straight away.
   */
  async add(planId: string, text: string): Promise<AddVouchersResult> {
    const { db } = this.deps;
    const tokens = text.split(/[\s,;]+/).filter(Boolean);
    const invalid = tokens.filter((c) => !CODE.test(c));
    const codes = [...new Set(tokens.filter((c) => CODE.test(c)))];
    if (codes.length > MAX_CODES_PER_UPLOAD) throw badRequest(`Add at most ${MAX_CODES_PER_UPLOAD} codes at a time`);

    const now = this.deps.now();
    const added = new Set<string>();
    for (let i = 0; i < codes.length; i += 1000) {
      const rows = await db
        .insert(vouchers)
        .values(codes.slice(i, i + 1000).map((code) => ({ planId, code, readyAt: now })))
        .onConflictDoNothing({ target: vouchers.code })
        .returning({ code: vouchers.code });
      rows.forEach((r) => added.add(r.code));
    }
    const assignedToWaiting = added.size ? await this.assignWaiting() : 0;
    return { added: added.size, duplicates: codes.filter((c) => !added.has(c)), invalid, assignedToWaiting };
  }

  /**
   * Generates codes to top each active plan up to its stock target, counting codes still waiting
   * for the router too. Returns the batch, or null if every plan is already at its target.
   * With a `period`, at most one batch is made for it, even if called repeatedly or concurrently.
   */
  async generate(opts: { period?: string } = {}): Promise<{ id: string; codeCount: number } | null> {
    const { db, logger } = this.deps;
    const countBy = async (where: ReturnType<typeof and>) =>
      new Map(
        (await db.select({ planId: vouchers.planId, n: count() }).from(vouchers).where(where).groupBy(vouchers.planId)).map(
          (r) => [r.planId, r.n],
        ),
      );
    const unused = await countBy(isNull(vouchers.orderId));
    // The target is also the most that can sell per cycle: codes already sold this cycle aren't
    // replaced until the next one, so "Generate now" mid-month can't lift the monthly cap.
    const soldThisCycle = await countBy(gte(vouchers.assignedAt, this.cycleStart()));
    const targets = await db.select().from(plans).where(eq(plans.active, true));
    const needs = targets
      .map((p) => ({
        planId: p.id,
        n: Math.max(0, p.voucherStockTarget - (unused.get(p.id) ?? 0) - (soldThisCycle.get(p.id) ?? 0)),
      }))
      .filter((x) => x.n > 0);
    const total = needs.reduce((sum, x) => sum + x.n, 0);
    if (total === 0) return null;

    const batch = await db.transaction(async (tx) => {
      const [b] = await tx
        .insert(voucherBatches)
        .values({ period: opts.period ?? null, codeCount: total })
        .onConflictDoNothing({ target: voucherBatches.period })
        .returning();
      if (!b) return null; // this period's batch already exists
      for (const { planId, n } of needs) {
        let made = 0;
        // Retry the rare code that collides with an existing one.
        while (made < n) {
          const rows = await tx
            .insert(vouchers)
            .values(Array.from({ length: n - made }, () => ({ planId, batchId: b.id, code: generateCode(GENERATED_CODE_LENGTH) })))
            .onConflictDoNothing({ target: vouchers.code })
            .returning({ id: vouchers.id });
          made += rows.length;
        }
      }
      return b;
    });
    if (batch) logger.info({ batchId: batch.id, codes: total, period: opts.period }, 'voucher batch generated');
    return batch && { id: batch.id, codeCount: batch.codeCount };
  }

  /**
   * The monthly job: from the configured day of the month (Lagos time) onwards, makes that month's
   * batch if it doesn't exist yet. Running late (e.g. the server was asleep on the 1st) still works.
   */
  async generateScheduled() {
    const lagos = new Date(this.deps.now().getTime() + 3600_000); // UTC+1, no DST
    if (lagos.getUTCDate() < this.deps.config.VOUCHER_GENERATION_DAY) return null;
    return this.generate({ period: lagos.toISOString().slice(0, 7) });
  }

  /** Start of the current monthly cycle: the most recent generation day, 00:00 Lagos time. */
  cycleStart(): Date {
    const day = this.deps.config.VOUCHER_GENERATION_DAY;
    const lagos = new Date(this.deps.now().getTime() + 3600_000);
    const y = lagos.getUTCFullYear();
    const m = lagos.getUTCMonth() - (lagos.getUTCDate() < day ? 1 : 0);
    return new Date(Date.UTC(y, m, day) - 3600_000);
  }

  /** The batch's codes are now on the router: they can be sold, and waiting orders get them. */
  async markReady(batchId: string, by: string): Promise<boolean> {
    const { db, logger } = this.deps;
    const now = this.deps.now();
    const done = await db.transaction(async (tx) => {
      const [b] = await tx
        .update(voucherBatches)
        .set({ readyAt: now, readyBy: by })
        .where(and(eq(voucherBatches.id, batchId), isNull(voucherBatches.readyAt)))
        .returning({ id: voucherBatches.id });
      if (!b) return false;
      await tx.update(vouchers).set({ readyAt: now }).where(and(eq(vouchers.batchId, batchId), isNull(vouchers.readyAt)));
      return true;
    });
    if (done) {
      logger.info({ batchId, by }, 'voucher batch loaded on router');
      await this.assignWaiting();
    }
    return done;
  }

  async batches(): Promise<VoucherBatchView[]> {
    const { db } = this.deps;
    const rows = await db.select().from(voucherBatches).orderBy(desc(voucherBatches.createdAt)).limit(24);
    if (!rows.length) return [];
    const perPlan = await db
      .select({ batchId: vouchers.batchId, planName: plans.name, n: count() })
      .from(vouchers)
      .innerJoin(plans, eq(plans.id, vouchers.planId))
      .where(inArray(vouchers.batchId, rows.map((b) => b.id)))
      .groupBy(vouchers.batchId, plans.name, plans.sortOrder)
      .orderBy(asc(plans.sortOrder));
    return rows.map((b) => ({
      id: b.id,
      period: b.period,
      codeCount: b.codeCount,
      plans: perPlan.filter((p) => p.batchId === b.id).map((p) => ({ planName: p.planName, count: p.n })),
      readyAt: b.readyAt?.toISOString() ?? null,
      readyBy: b.readyBy,
      createdAt: b.createdAt.toISOString(),
    }));
  }

  /** The codes of a batch (or of every batch still waiting for the router), with their plans. */
  async batchCodes(batchIds: string[]) {
    if (!batchIds.length) return [];
    return this.deps.db
      .select({ code: vouchers.code, batchId: vouchers.batchId, plan: plans })
      .from(vouchers)
      .innerJoin(plans, eq(plans.id, vouchers.planId))
      .where(inArray(vouchers.batchId, batchIds))
      .orderBy(asc(plans.sortOrder), asc(vouchers.code));
  }

  async waitingBatchIds(): Promise<string[]> {
    const rows = await this.deps.db
      .select({ id: voucherBatches.id })
      .from(voucherBatches)
      .where(isNull(voucherBatches.readyAt))
      .orderBy(asc(voucherBatches.createdAt));
    return rows.map((r) => r.id);
  }

  /** Sellable vouchers per plan. */
  async availableByPlan(): Promise<Map<string, number>> {
    const rows = await this.deps.db
      .select({ planId: vouchers.planId, n: count() })
      .from(vouchers)
      .where(sellable)
      .groupBy(vouchers.planId);
    return new Map(rows.map((r) => [r.planId, r.n]));
  }

  async stock(): Promise<VoucherStock[]> {
    const { db } = this.deps;
    const byPlan = async (where: ReturnType<typeof and>) =>
      new Map(
        (await db.select({ planId: vouchers.planId, n: count() }).from(vouchers).where(where).groupBy(vouchers.planId)).map(
          (r) => [r.planId, r.n],
        ),
      );
    const used = await byPlan(isNotNull(vouchers.orderId));
    const notOnRouter = await byPlan(and(isNull(vouchers.orderId), isNull(vouchers.readyAt)));
    const waiting = await db
      .select({ planId: orders.planId, n: count() })
      .from(orders)
      .leftJoin(vouchers, eq(vouchers.orderId, orders.id))
      .where(and(eq(orders.status, 'success'), isNull(vouchers.id)))
      .groupBy(orders.planId);
    const available = await this.availableByPlan();
    const waitingBy = new Map(waiting.map((r) => [r.planId, r.n]));
    const allPlans = await db.select().from(plans).orderBy(asc(plans.sortOrder), asc(plans.priceKobo));
    return allPlans.map((p) => ({
      planId: p.id,
      planName: p.name,
      active: p.active,
      target: p.voucherStockTarget,
      available: available.get(p.id) ?? 0,
      waitingForRouter: notOnRouter.get(p.id) ?? 0,
      used: used.get(p.id) ?? 0,
      waitingOrders: waitingBy.get(p.id) ?? 0,
    }));
  }
}
