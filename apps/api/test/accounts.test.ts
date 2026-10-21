import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, signUp } from './helpers';

type Ctx = Awaited<ReturnType<typeof createTestContext>>;

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

  it('lists paid and failed purchases on the account, newest first', async () => {
    const agent = await signUp(ctx.app);
    const buy = async (outcome?: 'success' | 'failed') => {
      const { body } = await agent.post('/api/orders').send({ planId: ctx.plan.id }).expect(201);
      if (outcome) await request(ctx.app).post(`/api/dev/mock-pay/${body.reference}`).send({ outcome }).expect(200);
      return body.reference as string;
    };
    const paid = await buy('success');
    const failed = await buy('failed');
    await buy(); // abandoned checkout: not shown

    const { body } = await agent.get('/api/me/orders').expect(200);
    expect(body.map((o: { reference: string }) => o.reference)).toEqual([failed, paid]);
    expect(body[1]).toMatchObject({ status: 'success', planName: '1 Hour', amountKobo: 10_000 });
    expect(body[1].paidAt).not.toBeNull();
    expect(body[0]).toMatchObject({ status: 'failed', paidAt: null });
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
