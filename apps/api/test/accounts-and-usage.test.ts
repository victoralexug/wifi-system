import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, signUp } from './helpers';

type Ctx = Awaited<ReturnType<typeof createTestContext>>;
const MB = 1024 * 1024;

describe('customer accounts', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await createTestContext();
  });
  afterEach(() => ctx.close());

  it('registers, signs in with any phone format, and rejects wrong passwords', async () => {
    const agent = request.agent(ctx.app);
    const reg = await agent
      .post('/api/auth/register')
      .send({ phone: '0803 123 4567', password: 'secret-pass', name: 'Ada' })
      .expect(201);
    expect(reg.body).toMatchObject({ phone: '+2348031234567', name: 'Ada' });
    expect((await agent.get('/api/me').expect(200)).body.phone).toBe('+2348031234567');

    await request(ctx.app).post('/api/auth/register').send({ phone: '+2348031234567', password: 'another-pass' }).expect(409);
    await request(ctx.app).post('/api/auth/login').send({ phone: '08031234567', password: 'wrong-pass' }).expect(401);
    await request(ctx.app).post('/api/auth/login').send({ phone: '2348031234567', password: 'secret-pass' }).expect(200);
    await request(ctx.app).post('/api/auth/register').send({ phone: '08031234568', password: 'short' }).expect(400);

    await agent.post('/api/auth/logout').expect(204);
    await agent.get('/api/me').expect(401);
  });

  it('lets customers change their password', async () => {
    const agent = await signUp(ctx.app, '08030000001', 'first-password');
    await agent.post('/api/me/password').send({ currentPassword: 'nope-nope', newPassword: 'second-password' }).expect(400);
    await agent.post('/api/me/password').send({ currentPassword: 'first-password', newPassword: 'second-password' }).expect(204);
    await request(ctx.app).post('/api/auth/login').send({ phone: '08030000001', password: 'second-password' }).expect(200);
  });

  it("never shows one customer another customer's order", async () => {
    const ada = await signUp(ctx.app, '08030000001');
    const bayo = await signUp(ctx.app, '08030000002');
    const { body } = await ada.post('/api/orders').send({ planId: ctx.plan.id }).expect(201);
    await bayo.get(`/api/orders/${body.reference}`).expect(404);
    await bayo.post(`/api/orders/${body.reference}/verify`).expect(404);
    await ada.get(`/api/orders/${body.reference}`).expect(200);
  });
});

describe('data bundles and usage', () => {
  let ctx: Ctx;
  let customer: Awaited<ReturnType<typeof signUp>>;
  beforeEach(async () => {
    ctx = await createTestContext();
    customer = await signUp(ctx.app);
  });
  afterEach(() => ctx.close());

  const buy = async (planId: string) => {
    const { body } = await customer.post('/api/orders').send({ planId }).expect(201);
    const paid = await request(ctx.app).post(`/api/dev/mock-pay/${body.reference}`).send({ outcome: 'success' }).expect(200);
    return paid.body.session.voucherCode as string;
  };
  const mySessions = async () => (await customer.get('/api/me/sessions').expect(200)).body;

  it('pushes the data cap to the router and reports usage to the customer', async () => {
    const code = await buy(ctx.bundlePlan.id);
    expect(ctx.network.users.get(code)).toMatchObject({ dataCapMb: 1024, durationMinutes: 30 * 1440 });

    ctx.network.usage.set(code, 300 * MB);
    await ctx.sessions.syncUsage();
    const [s] = await mySessions();
    expect(s).toMatchObject({ voucherCode: code, status: 'active', dataCapMb: 1024, bytesUsed: 300 * MB });
    expect(s.usageUpdatedAt).not.toBeNull();
  });

  it('ends the session when the bundle is used up, before the time runs out', async () => {
    const code = await buy(ctx.bundlePlan.id);
    ctx.network.usage.set(code, 1024 * MB);
    expect(await ctx.sessions.syncUsage()).toEqual({ updated: 1, exhausted: 1 });
    expect(ctx.network.users.has(code)).toBe(false);
    const [s] = await mySessions();
    expect(s.status).toBe('exhausted');

    // Once exhausted it is no longer polled or expired again.
    ctx.clock.advance(31 * 1440 * 60_000);
    expect(await ctx.sessions.expireDue()).toBe(0);
  });

  it('ends the session when the time runs out, even with data left', async () => {
    const code = await buy(ctx.bundlePlan.id);
    ctx.network.usage.set(code, 10 * MB);
    await ctx.sessions.syncUsage();
    ctx.clock.advance(30 * 1440 * 60_000 + 60_000);
    await ctx.sessions.syncUsage();
    expect(await ctx.sessions.expireDue()).toBe(1);
    const [s] = await mySessions();
    expect(s.status).toBe('expired');
  });

  it('never loses counted usage when the router counter resets', async () => {
    const code = await buy(ctx.bundlePlan.id);
    ctx.network.usage.set(code, 600 * MB);
    await ctx.sessions.syncUsage();
    // Router rebooted: its counter starts again from zero.
    ctx.network.usage.set(code, 100 * MB);
    await ctx.sessions.syncUsage();
    expect((await mySessions())[0].bytesUsed).toBe(700 * MB);
    ctx.network.usage.set(code, 450 * MB);
    await ctx.sessions.syncUsage();
    const [s] = await mySessions();
    expect(s.bytesUsed).toBe(1050 * MB);
    expect(s.status).toBe('exhausted');
  });

  it('tracks usage on unlimited time passes without ever exhausting them', async () => {
    const code = await buy(ctx.plan.id);
    ctx.network.usage.set(code, 50 * 1024 * MB);
    expect(await ctx.sessions.syncUsage()).toEqual({ updated: 1, exhausted: 0 });
    const [s] = await mySessions();
    expect(s).toMatchObject({ status: 'active', dataCapMb: null, bytesUsed: 50 * 1024 * MB });
  });

  it('keeps the session active and retries if the router is down when the bundle runs out', async () => {
    const code = await buy(ctx.bundlePlan.id);
    ctx.network.usage.set(code, 2048 * MB);
    ctx.network.failNext = 1;
    await expect(ctx.sessions.syncUsage()).rejects.toThrow(/unreachable/);
    expect((await mySessions())[0].status).toBe('active');
    expect(await ctx.sessions.syncUsage()).toEqual({ updated: 1, exhausted: 1 });
  });
});
