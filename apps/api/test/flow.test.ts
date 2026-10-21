import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { orders } from '../src/db/schema';
import type { MockPaymentProvider } from '../src/payments/mock';
import { createTestContext, signUp } from './helpers';

type Ctx = Awaited<ReturnType<typeof createTestContext>>;

describe('purchase → payment confirmation', () => {
  let ctx: Ctx;
  let customer: Awaited<ReturnType<typeof signUp>>;
  beforeEach(async () => {
    ctx = await createTestContext();
    customer = await signUp(ctx.app);
  });
  afterEach(() => ctx.close());

  const createOrder = async (planId = ctx.plan.id) => {
    const res = await customer.post('/api/orders').send({ planId }).expect(201);
    return res.body as { reference: string; authorizationUrl: string };
  };
  const settle = (reference: string, outcome: 'success' | 'failed' = 'success') =>
    request(ctx.app).post(`/api/dev/mock-pay/${reference}`).send({ outcome });
  const statusOf = async (reference: string) =>
    (await ctx.deps.db.select().from(orders).where(eq(orders.reference, reference)))[0]!.status;

  it('lists active plans in order', async () => {
    const res = await request(ctx.app).get('/api/plans').expect(200);
    expect(res.body.map((p: { name: string }) => p.name)).toEqual(['1 Hour', '24 Hours', '1 GB Monthly']);
  });

  it('requires a signed-in customer to buy', async () => {
    await request(ctx.app).post('/api/orders').send({ planId: ctx.plan.id }).expect(401);
  });

  it('marks an order paid only after the payment is verified', async () => {
    const { reference, authorizationUrl } = await createOrder();
    expect(authorizationUrl).toContain('/mock-pay?reference=');

    const before = await customer.get(`/api/orders/${reference}`).expect(200);
    expect(before.body).toMatchObject({ status: 'pending', paidAt: null });

    const paid = await settle(reference).expect(200);
    expect(paid.body).toMatchObject({ reference, status: 'success', planName: '1 Hour', amountKobo: 10_000 });
    expect(paid.body.paidAt).not.toBeNull();
  });

  it('records a declined payment as failed', async () => {
    const { reference } = await createOrder();
    const res = await settle(reference, 'failed').expect(200);
    expect(res.body).toMatchObject({ status: 'failed', paidAt: null });
  });

  it('confirms a payment exactly once under concurrent confirmations', async () => {
    const { reference } = await createOrder();
    (ctx.payments as MockPaymentProvider).settle(reference, 'success');
    const results = await Promise.all(Array.from({ length: 5 }, () => ctx.orders.confirmPayment(reference)));
    expect(results.filter((r) => r === 'paid')).toHaveLength(1);
    expect(results.filter((r) => r === 'already_paid')).toHaveLength(4);
  });

  it('flags amount mismatches instead of marking the order paid', async () => {
    const { reference } = await createOrder();
    (ctx.payments as MockPaymentProvider).settle(reference, 'success', 100);
    expect(await ctx.orders.confirmPayment(reference)).toBe('flagged');
    expect(await statusOf(reference)).toBe('flagged');
  });

  it('"check my payment" picks up payments whose webhook never arrived', async () => {
    const { reference } = await createOrder();
    (ctx.payments as MockPaymentProvider).settle(reference, 'success');
    const res = await customer.post(`/api/orders/${reference}/verify`).expect(200);
    expect(res.body.status).toBe('success');
  });


  it('reconciliation job confirms stale pending orders', async () => {
    const { reference } = await createOrder();
    (ctx.payments as MockPaymentProvider).settle(reference, 'success');
    // reconcile looks at orders between 1 and 60 minutes old (by DB timestamp, which is real time)
    await ctx.deps.db
      .update(orders)
      .set({ createdAt: new Date(Date.now() - 5 * 60_000) })
      .where(eq(orders.reference, reference));
    ctx.deps.now = () => new Date();
    await ctx.orders.reconcilePending();
    expect(await statusOf(reference)).toBe('success');
  });
});
