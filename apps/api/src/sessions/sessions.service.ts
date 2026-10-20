import { and, asc, eq, inArray, lt, lte, sql } from 'drizzle-orm';
import type { Database } from '../db/client';
import { accessSessions, orders, plans } from '../db/schema';
import type { Deps } from '../deps';
import { generateVoucherCode } from '../lib/ids';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type OrderRow = typeof orders.$inferSelect;
type PlanRow = typeof plans.$inferSelect;
export type SessionRow = typeof accessSessions.$inferSelect;

export class SessionService {
  constructor(private readonly deps: Pick<Deps, 'db' | 'network' | 'logger' | 'now' | 'config'>) {}

  /** Creates the (pending) session for a paid order. Safe to call repeatedly. */
  async createForOrder(tx: Tx | Database, order: OrderRow, plan: PlanRow): Promise<SessionRow> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const inserted = await tx
        .insert(accessSessions)
        .values({
          orderId: order.id,
          customerId: order.customerId,
          planId: plan.id,
          voucherCode: generateVoucherCode(),
          planName: plan.name,
          durationMinutes: plan.durationMinutes,
          rateLimit: plan.rateLimit,
          dataCapMb: plan.dataCapMb,
        })
        .onConflictDoNothing()
        .returning();
      if (inserted[0]) return inserted[0];
      // The conflict was on order_id (session already exists) or, very rarely, on voucher_code.
      const [existing] = await tx.select().from(accessSessions).where(eq(accessSessions.orderId, order.id));
      if (existing) return existing;
    }
    throw new Error(`could not allocate a unique voucher code for order ${order.id}`);
  }

  /** Pushes a pending session to the controller. Failures are recorded and retried by the job. */
  async provision(sessionId: string): Promise<SessionRow | undefined> {
    const { db, network, logger } = this.deps;
    const [s] = await db.select().from(accessSessions).where(eq(accessSessions.id, sessionId));
    if (!s || s.status !== 'pending') return s;

    try {
      const { controllerRef } = await network.grantAccess({
        username: s.voucherCode,
        password: s.voucherCode,
        durationMinutes: s.durationMinutes,
        rateLimit: s.rateLimit,
        dataCapMb: s.dataCapMb,
        comment: `yourwifi session ${s.id}`,
      });
      const startsAt = this.deps.now();
      const expiresAt = new Date(startsAt.getTime() + s.durationMinutes * 60_000);
      const [updated] = await db
        .update(accessSessions)
        .set({
          status: 'active',
          startsAt,
          expiresAt,
          controllerRef,
          lastError: null,
          provisionAttempts: sql`${accessSessions.provisionAttempts} + 1`,
        })
        .where(and(eq(accessSessions.id, s.id), eq(accessSessions.status, 'pending')))
        .returning();
      logger.info({ sessionId: s.id, expiresAt }, 'session activated');
      return updated ?? s;
    } catch (err) {
      const message = (err as Error).message;
      logger.warn({ sessionId: s.id, err: message }, 'provisioning failed; will retry');
      const [updated] = await db
        .update(accessSessions)
        .set({ lastError: message, provisionAttempts: sql`${accessSessions.provisionAttempts} + 1` })
        .where(eq(accessSessions.id, s.id))
        .returning();
      return updated;
    }
  }

  async retryPending(): Promise<number> {
    const pending = await this.deps.db
      .select({ id: accessSessions.id })
      .from(accessSessions)
      .where(
        and(
          eq(accessSessions.status, 'pending'),
          lt(accessSessions.provisionAttempts, this.deps.config.MAX_PROVISION_ATTEMPTS),
        ),
      )
      .orderBy(asc(accessSessions.createdAt))
      .limit(50);
    for (const { id } of pending) await this.provision(id);
    return pending.length;
  }

  /** Revokes sessions whose wall-clock time is up. If the router call fails, the session stays active and is retried next tick. */
  async expireDue(): Promise<number> {
    const { db, network, logger } = this.deps;
    const due = await db
      .select()
      .from(accessSessions)
      .where(and(eq(accessSessions.status, 'active'), lte(accessSessions.expiresAt, this.deps.now())))
      .limit(100);
    let expired = 0;
    for (const s of due) {
      try {
        await network.revokeAccess(s.voucherCode);
        await db
          .update(accessSessions)
          .set({ status: 'expired', lastError: null })
          .where(and(eq(accessSessions.id, s.id), eq(accessSessions.status, 'active')));
        expired++;
        logger.info({ sessionId: s.id }, 'session expired');
      } catch (err) {
        const message = (err as Error).message;
        logger.warn({ sessionId: s.id, err: message }, 'expiry revoke failed; will retry');
        await db.update(accessSessions).set({ lastError: message }).where(eq(accessSessions.id, s.id));
      }
    }
    return expired;
  }

  /**
   * Reads live usage from the controller and ends sessions whose data bundle is used up.
   * The router's limit-bytes-total is only a backstop: RouterOS updates a user's totals at
   * logout, so a long session could overrun it. This check bounds any overrun to one poll interval.
   */
  async syncUsage(): Promise<{ updated: number; exhausted: number }> {
    const { db, network, logger } = this.deps;
    const active = await db.select().from(accessSessions).where(eq(accessSessions.status, 'active'));
    if (active.length === 0) return { updated: 0, exhausted: 0 };

    const usage = await network.getUsage();
    const now = this.deps.now();
    let updated = 0;
    let exhausted = 0;
    for (const s of active) {
      const raw = usage.get(s.voucherCode);
      if (raw === undefined) continue;
      // A lower reading means the counter was reset, so the whole reading is new traffic.
      const delta = raw >= s.controllerBytes ? raw - s.controllerBytes : raw;
      const bytesUsed = s.bytesUsed + delta;
      await db
        .update(accessSessions)
        .set({ bytesUsed, controllerBytes: raw, usageUpdatedAt: now })
        .where(eq(accessSessions.id, s.id));
      updated++;

      if (s.dataCapMb !== null && bytesUsed >= s.dataCapMb * 1024 * 1024) {
        try {
          await network.revokeAccess(s.voucherCode);
          await db
            .update(accessSessions)
            .set({ status: 'exhausted', lastError: null })
            .where(and(eq(accessSessions.id, s.id), eq(accessSessions.status, 'active')));
          exhausted++;
          logger.info({ sessionId: s.id, bytesUsed }, 'data bundle used up');
        } catch (err) {
          // Stays active and is retried on the next poll.
          const message = (err as Error).message;
          logger.warn({ sessionId: s.id, err: message }, 'revoke after bundle exhausted failed; will retry');
          await db.update(accessSessions).set({ lastError: message }).where(eq(accessSessions.id, s.id));
        }
      }
    }
    return { updated, exhausted };
  }

  /** Admin action. Throws if the controller can't be reached, so the admin can see the failure. */
  async revoke(sessionId: string): Promise<SessionRow | undefined> {
    const { db, network } = this.deps;
    const [s] = await db.select().from(accessSessions).where(eq(accessSessions.id, sessionId));
    if (!s || !['active', 'pending'].includes(s.status)) return s;
    await network.revokeAccess(s.voucherCode);
    const [updated] = await db
      .update(accessSessions)
      .set({ status: 'revoked', lastError: null })
      .where(and(eq(accessSessions.id, s.id), inArray(accessSessions.status, ['active', 'pending'])))
      .returning();
    return updated ?? s;
  }

  /** Admin action: resets the attempt counter on a stuck session and tries once more right away. */
  async retry(sessionId: string): Promise<SessionRow | undefined> {
    await this.deps.db
      .update(accessSessions)
      .set({ provisionAttempts: 0 })
      .where(and(eq(accessSessions.id, sessionId), eq(accessSessions.status, 'pending')));
    return this.provision(sessionId);
  }
}
