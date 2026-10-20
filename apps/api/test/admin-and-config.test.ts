import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { createTestContext, signUp } from './helpers';

describe('config guards', () => {
  it('refuses simulated payments or network in production', () => {
    const base = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://x',
      ADMIN_JWT_SECRET: 'x'.repeat(40),
      PAYSTACK_SECRET_KEY: 'sk_live_x',
      MIKROTIK_URL: 'https://10.8.0.2',
      MIKROTIK_USER: 'api',
      MIKROTIK_PASSWORD: 'p',
    };
    expect(() => loadConfig({ ...base, PAYMENT_DRIVER: 'mock', NETWORK_DRIVER: 'mikrotik' })).toThrow(/PAYMENT_DRIVER=mock/);
    expect(() => loadConfig({ ...base, PAYMENT_DRIVER: 'paystack', NETWORK_DRIVER: 'mock' })).toThrow(/NETWORK_DRIVER=mock/);
    expect(() =>
      loadConfig({ ...base, PAYMENT_DRIVER: 'paystack', NETWORK_DRIVER: 'mikrotik', PAYSTACK_SECRET_KEY: 'sk_test_x' }),
    ).toThrow(/test key/);
    expect(loadConfig({ ...base, PAYMENT_DRIVER: 'paystack', NETWORK_DRIVER: 'mikrotik' }).isProd).toBe(true);
  });
});

describe('admin API', () => {
  let ctx: Awaited<ReturnType<typeof createTestContext>>;
  afterEach(() => ctx.close());

  it('requires login, then serves stats, sessions and revocation', async () => {
    ctx = await createTestContext();
    await request(ctx.app).get('/api/admin/stats').expect(401);
    await request(ctx.app)
      .post('/api/admin/login')
      .send({ email: 'admin@example.com', password: 'wrong' })
      .expect(401);

    const agent = request.agent(ctx.app);
    await agent.post('/api/admin/login').send({ email: 'ADMIN@example.com', password: 'correct-horse-battery' }).expect(200);

    const customer = await signUp(ctx.app, '07011112222');
    const order = await customer.post('/api/orders').send({ planId: ctx.plan.id }).expect(201);
    await request(ctx.app).post(`/api/dev/mock-pay/${order.body.reference}`).send({ outcome: 'success' }).expect(200);

    const stats = await agent.get('/api/admin/stats').expect(200);
    expect(stats.body.revenueKobo.today).toBe(10_000);
    expect(stats.body.activeSessions).toBe(1);
    expect(stats.body.dailyRevenue).toHaveLength(14);
    // Today's bucket must hold today's revenue, whatever the database session time zone is.
    expect(stats.body.dailyRevenue.at(-1).revenueKobo).toBe(10_000);

    const list = await agent.get('/api/admin/sessions?q=0701').expect(200);
    expect(list.body.total).toBe(1);
    const session = list.body.items[0];
    expect(session.phone).toBe('+2347011112222');

    await agent.post(`/api/admin/sessions/${session.id}/revoke`).expect(200);
    expect(ctx.network.users.size).toBe(0);
    const after = await agent.get('/api/admin/sessions?status=revoked').expect(200);
    expect(after.body.total).toBe(1);

    const created = await agent
      .post('/api/admin/plans')
      .send({ name: '30 Days', priceKobo: 700_000, durationMinutes: 43200, rateLimit: '10M/10M' })
      .expect(201);
    await agent.patch(`/api/admin/plans/${created.body.id}`).send({ active: false }).expect(200);
    await agent.post('/api/admin/plans').send({ name: 'Bad', priceKobo: 1000, durationMinutes: 60, rateLimit: 'fast' }).expect(400);

    // Support flow: reset a forgotten customer password, then the customer signs in with it.
    const customers = await agent.get('/api/admin/customers?q=0701').expect(200);
    expect(customers.body.items[0]).toMatchObject({ phone: '+2347011112222', hasPassword: true, orders: 1, spentKobo: 10_000 });
    const reset = await agent.post(`/api/admin/customers/${customers.body.items[0].id}/reset-password`).expect(200);
    await request(ctx.app)
      .post('/api/auth/login')
      .send({ phone: '07011112222', password: reset.body.temporaryPassword })
      .expect(200);

    // A customer cookie must never open the admin API.
    await customer.get('/api/admin/stats').expect(401);
  });
});
