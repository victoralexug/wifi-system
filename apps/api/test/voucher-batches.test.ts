import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { plans } from '../src/db/schema';
import { createTestContext, signUp } from './helpers';

type Ctx = Awaited<ReturnType<typeof createTestContext>>;
const ROUTER_TOKEN = 'test-router-token-0123456789abcdef0123';

describe('generated voucher batches', () => {
  let ctx: Ctx;
  afterEach(() => ctx.close());

  const setup = async () => {
    ctx = await createTestContext({ vouchersPerPlan: 0, env: { ROUTER_TOKEN } });
    const admin = request.agent(ctx.app);
    await admin.post('/api/admin/login').send({ email: 'admin@example.com', password: 'correct-horse-battery' }).expect(200);
    await admin.patch(`/api/admin/plans/${ctx.plan.id}`).send({ voucherStockTarget: 3 }).expect(200);
    await admin.patch(`/api/admin/plans/${ctx.bundlePlan.id}`).send({ voucherStockTarget: 2 }).expect(200);
    return admin;
  };
  const router = () => ({ Authorization: `Bearer ${ROUTER_TOKEN}` });

  it('generates codes up to each plan target, but sells none until the router has them', async () => {
    const admin = await setup();
    const { body } = await admin.post('/api/admin/vouchers/batches').expect(201);
    expect(body.batch.codeCount).toBe(5);
    // Already at target: nothing more to generate.
    expect((await admin.post('/api/admin/vouchers/batches').expect(200)).body.batch).toBeNull();

    const stock = (await admin.get('/api/admin/vouchers/stock').expect(200)).body;
    expect(stock.find((s: { planId: string }) => s.planId === ctx.plan.id)).toMatchObject({ target: 3, available: 0, waitingForRouter: 3 });
    const plansList = (await request(ctx.app).get('/api/plans').expect(200)).body;
    expect(plansList.find((p: { id: string }) => p.id === ctx.plan.id).soldOut).toBe(true);

    const customer = await signUp(ctx.app);
    await customer.post('/api/orders').send({ planId: ctx.plan.id }).expect(409);
  });

  it('lets an admin download a batch for the router, then put it on sale', async () => {
    const admin = await setup();
    const { batch } = (await admin.post('/api/admin/vouchers/batches').expect(201)).body;

    const rsc = await admin.get(`/api/admin/vouchers/batches/${batch.id}/export?format=rsc`).expect(200);
    expect(rsc.headers['content-disposition']).toContain('.rsc');
    const userLines = rsc.text.split('\n').filter((l) => l.includes(' add name="') && l.includes('password='));
    expect(userLines).toHaveLength(5);
    expect(rsc.text).toContain('limit-uptime=1h');
    expect(rsc.text).toContain(`limit-bytes-total=${1024 * 1024 * 1024}`);
    expect(rsc.text).not.toContain('/tool fetch'); // admin downloads don't confirm themselves

    const csv = await admin.get(`/api/admin/vouchers/batches/${batch.id}/export?format=csv`).expect(200);
    expect(csv.text.trim().split('\n')).toHaveLength(6);

    await admin.post(`/api/admin/vouchers/batches/${batch.id}/ready`).expect(204);
    await admin.post(`/api/admin/vouchers/batches/${batch.id}/ready`).expect(404); // already loaded
    const [b] = (await admin.get('/api/admin/vouchers/batches').expect(200)).body;
    expect(b).toMatchObject({ readyBy: 'admin@example.com', codeCount: 5 });

    const customer = await signUp(ctx.app);
    const order = (await customer.post('/api/orders').send({ planId: ctx.plan.id }).expect(201)).body;
    const paid = await request(ctx.app).post(`/api/dev/mock-pay/${order.reference}`).send({ outcome: 'success' }).expect(200);
    expect(paid.body.voucherCode).toMatch(/^[2-9A-Z]{8}$/);
  });

  it('lets the router collect waiting batches and confirm them', async () => {
    const admin = await setup();
    await request(ctx.app).get('/api/router/vouchers.rsc').expect(401);
    expect((await request(ctx.app).get('/api/router/vouchers.rsc').set(router()).expect(200)).text).toContain('no new voucher codes');

    const { batch } = (await admin.post('/api/admin/vouchers/batches').expect(201)).body;
    const script = (await request(ctx.app).get('/api/router/vouchers.rsc').set(router()).expect(200)).text;
    const ack = script.match(/url="[^"]*(\/api\/router\/batches\/[^"]+\/ack)"/)![1]!;
    expect(ack).toContain(batch.id);
    expect(script).toContain(`Authorization: Bearer ${ROUTER_TOKEN}`);

    // The script's last step: the router confirms the import.
    await request(ctx.app).post(ack).set(router()).expect(204);
    await request(ctx.app).post(ack).set(router()).expect(204); // a repeat is harmless
    expect((await admin.get('/api/admin/vouchers/batches').expect(200)).body[0].readyBy).toBe('router');
    expect((await request(ctx.app).get('/api/router/vouchers.rsc').set(router()).expect(200)).text).toContain('no new voucher codes');
    await request(ctx.app).post('/api/router/batches/not-a-uuid/ack').set(router()).expect(404);
  });

  it('gives codes from a newly loaded batch to orders that were waiting', async () => {
    const admin = await setup();
    // One uploaded code for the 1 Hour plan; two customers pay for it.
    await admin.post('/api/admin/vouchers').send({ planId: ctx.plan.id, codes: 'ONLY-ONE' }).expect(201);
    const pay = async (phone: string) => {
      const c = await signUp(ctx.app, phone);
      const o = (await c.post('/api/orders').send({ planId: ctx.plan.id }).expect(201)).body;
      return o.reference as string;
    };
    const first = await pay('08030000001');
    const second = await pay('08030000002');
    await request(ctx.app).post(`/api/dev/mock-pay/${first}`).send({ outcome: 'success' }).expect(200);
    const late = await request(ctx.app).post(`/api/dev/mock-pay/${second}`).send({ outcome: 'success' }).expect(200);
    expect(late.body.voucherCode).toBeNull();

    // The code sold this cycle counts against the 1 Hour plan's monthly 3, so it gets 2 (plus 2 for the bundle).
    const { batch } = (await admin.post('/api/admin/vouchers/batches').expect(201)).body;
    expect(batch.codeCount).toBe(2 + 2);
    await admin.post(`/api/admin/vouchers/batches/${batch.id}/ready`).expect(204);
    const after = (await ctx.orders.getStatus(second)).voucherCode;
    expect(after).toMatch(/^[2-9A-Z]{8}$/);
  });

  it('never lets more than the target sell in one cycle, even with "Generate now"', async () => {
    ctx = await createTestContext({ vouchersPerPlan: 0, env: { VOUCHER_GENERATION_DAY: '2' } });
    await ctx.deps.db.update(plans).set({ voucherStockTarget: 0 });
    await ctx.deps.db.update(plans).set({ voucherStockTarget: 2 }).where(eq(plans.id, ctx.plan.id));
    const at = (iso: string) => {
      ctx.deps.now = () => new Date(iso);
    };
    const sellAll = async () => {
      for (const phone of ['08030000001', '08030000002']) {
        const c = await signUp(ctx.app, phone);
        const o = (await c.post('/api/orders').send({ planId: ctx.plan.id }).expect(201)).body;
        await request(ctx.app).post(`/api/dev/mock-pay/${o.reference}`).send({ outcome: 'success' }).expect(200);
      }
    };

    at('2026-11-02T08:00:00Z'); // cycle starts on the 2nd
    const nov = (await ctx.vouchers.generateScheduled())!;
    expect(nov.codeCount).toBe(2);
    await ctx.vouchers.markReady(nov.id, 'router');
    at('2026-11-10T08:00:00Z');
    await sellAll(); // the month's 2 are gone
    expect(await ctx.vouchers.generate()).toBeNull(); // mid-month top-up adds nothing

    at('2026-12-01T22:59:00Z'); // still 1 Dec in Lagos: same cycle
    expect(await ctx.vouchers.generate()).toBeNull();
    at('2026-12-02T08:00:00Z'); // next cycle: back up to 2
    expect((await ctx.vouchers.generateScheduled())?.codeCount).toBe(2);
  });

  it('makes one scheduled batch per month, from the configured day', async () => {
    ctx = await createTestContext({ vouchersPerPlan: 0, env: { VOUCHER_GENERATION_DAY: '1' } });
    await ctx.deps.db.update(plans).set({ voucherStockTarget: 4 });
    ctx.deps.now = () => new Date('2026-11-01T00:30:00Z'); // 01:30 on 1 Nov in Lagos
    const first = await ctx.vouchers.generateScheduled();
    expect(first?.codeCount).toBe(12); // three plans × 4
    // Codes are counted even before the router has them, so a rerun the same month makes nothing.
    expect(await ctx.vouchers.generateScheduled()).toBeNull();

    ctx.deps.now = () => new Date('2026-10-31T22:30:00Z'); // still 31 Oct in Lagos: October's batch
    await ctx.deps.db.update(plans).set({ voucherStockTarget: 5 });
    expect((await ctx.vouchers.generateScheduled())?.codeCount).toBe(3);

    await ctx.close();
    ctx = await createTestContext({ vouchersPerPlan: 0, env: { VOUCHER_GENERATION_DAY: '15' } });
    await ctx.deps.db.update(plans).set({ voucherStockTarget: 4 });
    ctx.deps.now = () => new Date('2026-11-14T12:00:00Z');
    expect(await ctx.vouchers.generateScheduled()).toBeNull(); // before the 15th
  });
});
