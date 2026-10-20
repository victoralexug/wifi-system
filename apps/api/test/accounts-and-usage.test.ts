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
      .send({ phone: '0803 123 4567', password: 'secret-pass', name: 'Ada', email: ' Ada@Example.com ' })
      .expect(201);
    expect(reg.body).toMatchObject({ phone: '+2348031234567', name: 'Ada', email: 'ada@example.com' });
    expect((await agent.get('/api/me').expect(200)).body.phone).toBe('+2348031234567');

    const register = (body: object) => request(ctx.app).post('/api/auth/register').send(body);
    const dup = await register({ phone: '+2348031234567', password: 'another-pass', email: 'other@example.com' }).expect(409);
    expect(dup.body.error.code).toBe('account_exists');
    await request(ctx.app).post('/api/auth/login').send({ phone: '08031234567', password: 'wrong-pass' }).expect(401);
    await request(ctx.app).post('/api/auth/login').send({ phone: '2348031234567', password: 'secret-pass' }).expect(200);
    await register({ phone: '08031234568', password: 'short', email: 'b@example.com' }).expect(400);
    // Email is required, must be valid, and can't belong to another account.
    await register({ phone: '08031234568', password: 'long-enough' }).expect(400);
    await register({ phone: '08031234568', password: 'long-enough', email: 'not-an-email' }).expect(400);
    const taken = await register({ phone: '08031234568', password: 'long-enough', email: 'ADA@example.com' }).expect(409);
    expect(taken.body.error.code).toBe('email_taken');

    await agent.post('/api/auth/logout').expect(204);
    await agent.get('/api/me').expect(401);
  });

  it('lets customers change their password', async () => {
    const agent = await signUp(ctx.app, '08030000001', 'first-password');
    await agent.post('/api/me/password').send({ currentPassword: 'nope-nope', newPassword: 'second-password' }).expect(400);
    await agent.post('/api/me/password').send({ currentPassword: 'first-password', newPassword: 'second-password' }).expect(204);
    await request(ctx.app).post('/api/auth/login').send({ phone: '08030000001', password: 'second-password' }).expect(200);
  });

  it('resets a forgotten password from the emailed link, once', async () => {
    await signUp(ctx.app, '08030000001', 'forgotten-pass');
    await request(ctx.app).post('/api/auth/forgot-password').send({ email: '08030000001@EXAMPLE.com' }).expect(204);
    expect(ctx.mail.sent).toHaveLength(1);
    const [mail] = ctx.mail.sent;
    expect(mail!.to).toBe('08030000001@example.com');
    const token = mail!.text.match(/\/reset-password#([\w-]+)/)![1]!;

    const agent = request.agent(ctx.app);
    const reset = await agent.post('/api/auth/reset-password').send({ token, password: 'brand-new-pass' }).expect(200);
    expect(reset.body.phone).toBe('+2348030000001');
    await agent.get('/api/me').expect(200); // signed in straight away

    const login = (password: string) => request(ctx.app).post('/api/auth/login').send({ phone: '08030000001', password });
    await login('forgotten-pass').expect(401);
    await login('brand-new-pass').expect(200);

    const again = await request(ctx.app).post('/api/auth/reset-password').send({ token, password: 'third-password' }).expect(400);
    expect(again.body.error.code).toBe('invalid_reset_token');
  });

  it('expires reset links, and answers the same whether or not the email has an account', async () => {
    await signUp(ctx.app, '08030000001');
    await request(ctx.app).post('/api/auth/forgot-password').send({ email: 'nobody@example.com' }).expect(204);
    expect(ctx.mail.sent).toHaveLength(0);

    await request(ctx.app).post('/api/auth/forgot-password').send({ email: '08030000001@example.com' }).expect(204);
    const token = ctx.mail.sent[0]!.text.match(/\/reset-password#([\w-]+)/)![1]!;
    ctx.clock.advance(31 * 60_000);
    await request(ctx.app).post('/api/auth/reset-password').send({ token, password: 'too-late-pass' }).expect(400);
    await request(ctx.app).post('/api/auth/reset-password').send({ token: 'made-up', password: 'guessing-pass' }).expect(400);
  });

  it('lets customers change their email after confirming their password', async () => {
    const agent = await signUp(ctx.app, '08030000001', 'my-password');
    await signUp(ctx.app, '08030000002');
    await agent.post('/api/me/email').send({ email: 'new@example.com', currentPassword: 'wrong-pass' }).expect(400);
    await agent.post('/api/me/email').send({ email: '08030000002@example.com', currentPassword: 'my-password' }).expect(409);
    const ok = await agent.post('/api/me/email').send({ email: 'New@Example.com', currentPassword: 'my-password' }).expect(200);
    expect(ok.body.email).toBe('new@example.com');

    await request(ctx.app).post('/api/auth/forgot-password').send({ email: 'new@example.com' }).expect(204);
    expect(ctx.mail.sent.map((m) => m.to)).toEqual(['new@example.com']);
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
