import type { CreateOrderResponse, OrderStatusResponse } from '@yourwifi/shared';
import { and, eq, gte, inArray, lte } from 'drizzle-orm';
import { accessSessions, customers, orders, plans } from '../db/schema';
import type { Deps } from '../deps';
import { badRequest, HttpError, notFound } from '../lib/errors';
import { generatePaymentReference, normalizeMac } from '../lib/ids';
import type { SessionService } from '../sessions/sessions.service';
import { toSessionView } from '../sessions/views';

export interface CreateOrderInput {
  planId: string;
  customerId: string;
  deviceMac?: string;
  deviceIp?: string;
}

export type ConfirmResult =
  | 'not_found'
  | 'already_paid'
  | 'paid'
  | 'still_pending'
  | 'failed'
  | 'flagged';

export class OrderService {
  constructor(
    private readonly deps: Deps,
    private readonly sessions: SessionService,
  ) {}

  async create(input: CreateOrderInput): Promise<CreateOrderResponse> {
    const { db, payments, config, logger } = this.deps;
    const [plan] = await db.select().from(plans).where(and(eq(plans.id, input.planId), eq(plans.active, true)));
    if (!plan) throw badRequest('That plan is not available');

    const [customer] = await db.select().from(customers).where(eq(customers.id, input.customerId));
    if (!customer) throw new HttpError(401, 'Please sign in to continue', 'unauthenticated');
    const phone = customer.phone;
    const email = customer.email ?? `${phone.slice(1)}@${config.PLACEHOLDER_EMAIL_DOMAIN}`;
    const reference = generatePaymentReference();
    const [order] = await db
      .insert(orders)
      .values({
        reference,
        customerId: customer.id,
        planId: plan.id,
        amountKobo: plan.priceKobo,
        email,
        deviceMac: normalizeMac(input.deviceMac),
        deviceIp: input.deviceIp ?? null,
      })
      .returning();

    try {
      const { authorizationUrl } = await payments.initialize({
        reference,
        amountKobo: plan.priceKobo,
        email,
        callbackUrl: new URL('/status', config.PUBLIC_PORTAL_URL).toString(),
        metadata: { orderId: order!.id, planId: plan.id, phone },
      });
      return { reference, authorizationUrl };
    } catch (err) {
      logger.error({ err, reference }, 'payment initialization failed');
      await db
        .update(orders)
        .set({ status: 'failed', failureReason: 'payment initialization failed' })
        .where(eq(orders.id, order!.id));
      throw new HttpError(502, 'Could not start payment. Please try again.', 'payment_init_failed');
    }
  }

  /**
   * Main path from payment to access. Called from webhooks, the "check my payment" button and
   * the reconciliation job. The provider's server-side verify is the only source of truth, and
   * the conditional status update means concurrent calls create at most one session.
   */
  async confirmPayment(reference: string, opts: { awaitProvision?: boolean } = {}): Promise<ConfirmResult> {
    const { db, payments, logger } = this.deps;
    const [order] = await db.select().from(orders).where(eq(orders.reference, reference));
    if (!order) return 'not_found';
    if (order.status === 'success') return 'already_paid';
    if (order.status === 'flagged') return 'flagged';

    const verified = await payments.verify(reference);
    if (verified.status === 'pending' || verified.status === 'abandoned') return 'still_pending';
    if (verified.status === 'failed') {
      await db
        .update(orders)
        .set({ status: 'failed', failureReason: 'payment failed at provider', providerPayload: verified.raw })
        .where(and(eq(orders.id, order.id), eq(orders.status, 'pending')));
      return 'failed';
    }

    if (verified.amountKobo !== order.amountKobo || verified.currency !== order.currency) {
      logger.error(
        { reference, expected: order.amountKobo, got: verified.amountKobo, currency: verified.currency },
        'payment amount/currency mismatch; order flagged for review',
      );
      await db
        .update(orders)
        .set({
          status: 'flagged',
          failureReason: `amount mismatch: expected ${order.amountKobo} ${order.currency}, got ${verified.amountKobo} ${verified.currency}`,
          providerPayload: verified.raw,
        })
        .where(eq(orders.id, order.id));
      return 'flagged';
    }

    const session = await db.transaction(async (tx) => {
      const [won] = await tx
        .update(orders)
        .set({ status: 'success', paidAt: verified.paidAt ?? this.deps.now(), failureReason: null, providerPayload: verified.raw })
        // 'failed' is included because Paystack lets a customer retry on the same reference.
        .where(and(eq(orders.id, order.id), inArray(orders.status, ['pending', 'failed'])))
        .returning();
      if (!won) return null;
      const [plan] = await tx.select().from(plans).where(eq(plans.id, won.planId));
      return this.sessions.createForOrder(tx, won, plan!);
    });

    if (!session) return 'already_paid';
    logger.info({ reference, sessionId: session.id }, 'payment confirmed');
    const provisioning = this.sessions.provision(session.id);
    if (opts.awaitProvision) await provisioning;
    else provisioning.catch((err) => logger.error({ err }, 'background provisioning crashed'));
    return 'paid';
  }

  /** Pass customerId to restrict the lookup to that customer's own orders. */
  async getStatus(reference: string, customerId?: string): Promise<OrderStatusResponse> {
    const { db } = this.deps;
    const [row] = await db
      .select({ order: orders, planName: plans.name })
      .from(orders)
      .innerJoin(plans, eq(plans.id, orders.planId))
      .where(eq(orders.reference, reference));
    if (!row || (customerId && row.order.customerId !== customerId)) throw notFound('Order not found');
    const [session] = await db.select().from(accessSessions).where(eq(accessSessions.orderId, row.order.id));
    return {
      reference,
      status: row.order.status,
      amountKobo: row.order.amountKobo,
      planName: row.planName,
      session: session ? toSessionView(session) : null,
    };
  }

  /** Catches payments whose webhook never arrived. Only recent orders are checked, to limit provider API calls. */
  async reconcilePending(): Promise<number> {
    const now = this.deps.now().getTime();
    const stale = await this.deps.db
      .select({ reference: orders.reference })
      .from(orders)
      .where(
        and(
          eq(orders.status, 'pending'),
          lte(orders.createdAt, new Date(now - 60_000)),
          gte(orders.createdAt, new Date(now - 60 * 60_000)),
        ),
      )
      .limit(25);
    for (const { reference } of stale) {
      try {
        await this.confirmPayment(reference);
      } catch (err) {
        this.deps.logger.warn({ err, reference }, 'reconcile verify failed');
      }
    }
    return stale.length;
  }
}
