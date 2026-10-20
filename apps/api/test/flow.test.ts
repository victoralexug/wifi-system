import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { accessSessions, orders } from '../src/db/schema';
import type { MockPaymentProvider } from '../src/payments/mock';
import { createTestContext, signUp } from './helpers';

type Ctx = Awaited<ReturnType<typeof createTestContext>>;

describe('purchase → access → expiry', () => {
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

  it('lists active plans in order', async () => {
    const res = await request(ctx.app).get('/api/plans').expect(200);
    expect(res.body.map((p: { name: string }) => p.name)).toEqual(['1 Hour', '24 Hours', '1 GB Monthly']);
  });

  it('requires a signed-in customer to buy', async () => {
    await request(ctx.app).post('/api/orders').send({ planId: ctx.plan.id }).expect(401);
  });

  it('grants access only after verified payment', async () => {
    const { reference, authorizationUrl } = await createOrder();
    expect(authorizationUrl).toContain('/mock-pay?reference=');

    const before = await customer.get(`/api/orders/${reference}`).expect(200);
    expect(before.body.status).toBe('pending');
    expect(before.body.session).toBeNull();
    expect(ctx.network.users.size).toBe(0);

    const paid = await settle(reference).expect(200);
    expect(paid.body.status).toBe('success');
    expect(paid.body.session.status).toBe('active');
    const code = paid.body.session.voucherCode as string;
    expect(code).toMatch(/^[2-9A-Z]{8}$/);
    expect(ctx.network.users.get(code)).toMatchObject({ durationMinutes: 60, rateLimit: '5M/5M' });
    expect(new Date(paid.body.session.expiresAt).getTime() - ctx.clock.now().getTime()).toBe(60 * 60_000);
  });

  it('a failed payment never creates a session', async () => {
    const { reference } = await createOrder();
    const res = await settle(reference, 'failed').expect(200);
    expect(res.body.status).toBe('failed');
    expect(res.body.session).toBeNull();
    expect(ctx.network.users.size).toBe(0);
  });

  it('is idempotent under concurrent confirmations', async () => {
    const { reference } = await createOrder();
    (ctx.payments as MockPaymentProvider).settle(reference, 'success');
    const results = await Promise.all(
      Array.from({ length: 5 }, () => ctx.orders.confirmPayment(reference, { awaitProvision: true })),
    );
    expect(results.filter((r) => r === 'paid')).toHaveLength(1);
    const sessions = await ctx.deps.db.select().from(accessSessions);
    expect(sessions).toHaveLength(1);
  });

  it('flags amount mismatches instead of granting access', async () => {
    const { reference } = await createOrder();
    (ctx.payments as MockPaymentProvider).settle(reference, 'success', 100);
    expect(await ctx.orders.confirmPayment(reference)).toBe('flagged');
    const [order] = await ctx.deps.db.select().from(orders).where(eq(orders.reference, reference));
    expect(order!.status).toBe('flagged');
    expect(await ctx.deps.db.select().from(accessSessions)).toHaveLength(0);
  });

  it('retries provisioning when the router is unreachable', async () => {
    const { reference } = await createOrder();
    ctx.network.failNext = 1;
    const paid = await settle(reference).expect(200);
    expect(paid.body.session.status).toBe('pending');

    await ctx.sessions.retryPending();
    const after = await customer.get(`/api/orders/${reference}`).expect(200);
    expect(after.body.session.status).toBe('active');
  });

  it('expires sessions on wall-clock time and revokes them on the router', async () => {
    const { reference } = await createOrder();
    const paid = await settle(reference).expect(200);
    const code = paid.body.session.voucherCode as string;

    ctx.clock.advance(59 * 60_000);
    expect(await ctx.sessions.expireDue()).toBe(0);
    ctx.clock.advance(2 * 60_000);
    expect(await ctx.sessions.expireDue()).toBe(1);

    expect(ctx.network.users.has(code)).toBe(false);
    const lookup = await request(ctx.app).post('/api/sessions/lookup').send({ code: code.toLowerCase() }).expect(200);
    expect(lookup.body.status).toBe('expired');
  });

  it('keeps a session active if revoking on the router fails, then retries', async () => {
    const { reference } = await createOrder();
    await settle(reference).expect(200);
    ctx.clock.advance(61 * 60_000);
    ctx.network.failNext = 1;
    expect(await ctx.sessions.expireDue()).toBe(0);
    expect(await ctx.sessions.expireDue()).toBe(1);
  });

  it('"check my payment" picks up payments whose webhook never arrived', async () => {
    const { reference } = await createOrder();
    (ctx.payments as MockPaymentProvider).settle(reference, 'success');
    const res = await customer.post(`/api/orders/${reference}/verify`).expect(200);
    expect(res.body.session.status).toBe('active');
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
    const [order] = await ctx.deps.db.select().from(orders).where(eq(orders.reference, reference));
    expect(order!.status).toBe('success');
  });
});
