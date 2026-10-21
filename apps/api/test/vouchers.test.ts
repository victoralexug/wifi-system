import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { vouchers } from '../src/db/schema';
import type { MockPaymentProvider } from '../src/payments/mock';
import { createTestContext, signUp } from './helpers';

type Ctx = Awaited<ReturnType<typeof createTestContext>>;

describe('vouchers', () => {
  let ctx: Ctx;
  afterEach(() => ctx.close());

  const adminAgent = async () => {
    const agent = request.agent(ctx.app);
    await agent.post('/api/admin/login').send({ email: 'admin@example.com', password: 'correct-horse-battery' }).expect(200);
    return agent;
  };
  const buy = async (customer: Awaited<ReturnType<typeof signUp>>, planId: string, outcome: 'success' | 'failed' = 'success') => {
    const { body } = await customer.post('/api/orders').send({ planId }).expect(201);
    const paid = await request(ctx.app).post(`/api/dev/mock-pay/${body.reference}`).send({ outcome }).expect(200);
    return paid.body as { reference: string; status: string; voucherCode: string | null };
  };

  it('gives each paid order a different voucher for its plan, and shows it only to the buyer', async () => {
    ctx = await createTestContext();
    const customer = await signUp(ctx.app);
    const first = await buy(customer, ctx.plan.id);
    const second = await buy(customer, ctx.plan.id);
    expect(first.voucherCode).toMatch(/^P0-\d$/); // the 1 Hour plan's codes
    expect(second.voucherCode).toMatch(/^P0-\d$/);
    expect(second.voucherCode).not.toBe(first.voucherCode);

    const bundle = await buy(customer, ctx.bundlePlan.id);
    expect(bundle.voucherCode).toMatch(/^P2-\d$/);

    const mine = (await customer.get('/api/me/orders').expect(200)).body;
    expect(mine.map((o: { voucherCode: string }) => o.voucherCode).sort()).toEqual(
      [first.voucherCode, second.voucherCode, bundle.voucherCode].sort(),
    );
    const stranger = await signUp(ctx.app, '08030000002');
    await stranger.get(`/api/orders/${first.reference}`).expect(404);
  });

  it('gives no voucher for a declined payment', async () => {
    ctx = await createTestContext();
    const customer = await signUp(ctx.app);
    const declined = await buy(customer, ctx.plan.id, 'failed');
    expect(declined).toMatchObject({ status: 'failed', voucherCode: null });
    const used = (await ctx.deps.db.select().from(vouchers)).filter((v) => v.orderId);
    expect(used).toHaveLength(0);
  });

  it('gives exactly one voucher when a payment is confirmed several times at once', async () => {
    ctx = await createTestContext();
    const customer = await signUp(ctx.app);
    const { body } = await customer.post('/api/orders').send({ planId: ctx.plan.id }).expect(201);
    (ctx.payments as MockPaymentProvider).settle(body.reference, 'success');
    await Promise.all(Array.from({ length: 5 }, () => ctx.orders.confirmPayment(body.reference)));
    const used = (await ctx.deps.db.select().from(vouchers)).filter((v) => v.orderId);
    expect(used).toHaveLength(1);
  });

  it('marks a plan sold out when its codes run out, and refuses new orders for it', async () => {
    ctx = await createTestContext({ vouchersPerPlan: 1 });
    const customer = await signUp(ctx.app);
    const soldOut = async () =>
      (await request(ctx.app).get('/api/plans').expect(200)).body.find((p: { id: string }) => p.id === ctx.plan.id).soldOut;

    expect(await soldOut()).toBe(false);
    await buy(customer, ctx.plan.id);
    expect(await soldOut()).toBe(true);
    const res = await customer.post('/api/orders').send({ planId: ctx.plan.id }).expect(409);
    expect(res.body.error.code).toBe('sold_out');
  });

  it('gives a waiting paid order a voucher as soon as an admin adds codes', async () => {
    ctx = await createTestContext({ vouchersPerPlan: 1 });
    const a = await signUp(ctx.app, '08030000001');
    const b = await signUp(ctx.app, '08030000002');
    // Both start checkout while one code is left; both pay. The second has to wait.
    const orderA = (await a.post('/api/orders').send({ planId: ctx.plan.id }).expect(201)).body;
    const orderB = (await b.post('/api/orders').send({ planId: ctx.plan.id }).expect(201)).body;
    await request(ctx.app).post(`/api/dev/mock-pay/${orderA.reference}`).send({ outcome: 'success' }).expect(200);
    const paidB = await request(ctx.app).post(`/api/dev/mock-pay/${orderB.reference}`).send({ outcome: 'success' }).expect(200);
    expect(paidB.body).toMatchObject({ status: 'success', voucherCode: null });

    const admin = await adminAgent();
    expect((await admin.get('/api/admin/stats').expect(200)).body.ordersWaitingForVoucher).toBe(1);

    const added = await admin
      .post('/api/admin/vouchers')
      .send({ planId: ctx.plan.id, codes: 'NEW-1\nNEW-2, NEW-2  P0-1 café' })
      .expect(201);
    expect(added.body).toMatchObject({ added: 2, duplicates: ['P0-1'], assignedToWaiting: 1 });
    expect(added.body.invalid).toEqual(['café']);

    const after = (await b.get(`/api/orders/${orderB.reference}`).expect(200)).body;
    expect(after.voucherCode).toMatch(/^NEW-[12]$/);
    expect((await admin.get('/api/admin/stats').expect(200)).body.ordersWaitingForVoucher).toBe(0);
  });

  it('lets admins see stock, list codes, and delete only unused ones', async () => {
    ctx = await createTestContext({ vouchersPerPlan: 2 });
    const customer = await signUp(ctx.app);
    const { voucherCode } = await buy(customer, ctx.plan.id);
    const admin = await adminAgent();

    const stock = (await admin.get('/api/admin/vouchers/stock').expect(200)).body;
    expect(stock.find((s: { planId: string }) => s.planId === ctx.plan.id)).toMatchObject({ available: 1, used: 1, waitingOrders: 0 });
    const stats = (await admin.get('/api/admin/stats').expect(200)).body;
    expect(stats.lowVoucherStock.map((s: { planName: string }) => s.planName)).toContain('1 Hour');

    const used = (await admin.get(`/api/admin/vouchers?status=used`).expect(200)).body;
    expect(used.items).toEqual([expect.objectContaining({ code: voucherCode, status: 'used', phone: '+2348031234567' })]);
    await admin.delete(`/api/admin/vouchers/${used.items[0].id}`).expect(400);

    const unused = (await admin.get(`/api/admin/vouchers?status=available&planId=${ctx.plan.id}`).expect(200)).body;
    expect(unused.total).toBe(1);
    await admin.delete(`/api/admin/vouchers/${unused.items[0].id}`).expect(204);
    expect((await admin.get(`/api/admin/vouchers?planId=${ctx.plan.id}`).expect(200)).body.total).toBe(1);

    // Customers can't reach any of this.
    await customer.get('/api/admin/vouchers').expect(401);
  });
});
