import { createHmac } from 'node:crypto';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accessSessions } from '../src/db/schema';
import { PaystackProvider } from '../src/payments/paystack';
import { createTestContext, signUp } from './helpers';

const SECRET = 'sk_test_abc123';
const sign = (body: string) => createHmac('sha512', SECRET).update(body).digest('hex');

/** Minimal fake of the Paystack API: initialize records amounts, verify returns them. */
function fakePaystack() {
  const txns = new Map<string, { amount: number; status: string }>();
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/transaction/initialize')) {
      const body = JSON.parse(String(init!.body));
      txns.set(body.reference, { amount: body.amount, status: 'ongoing' });
      return Response.json({
        status: true,
        message: 'ok',
        data: { authorization_url: `https://checkout.paystack.com/x${body.reference}`, reference: body.reference },
      });
    }
    const ref = decodeURIComponent(u.split('/transaction/verify/')[1]!);
    const t = txns.get(ref);
    if (!t) return Response.json({ status: false, message: 'Transaction reference not found' }, { status: 400 });
    return Response.json({
      status: true,
      message: 'ok',
      data: { status: t.status, reference: ref, amount: t.amount, currency: 'NGN', paid_at: '2026-10-19T10:00:00Z' },
    });
  });
  return { txns, fetchImpl };
}

describe('PaystackProvider', () => {
  it('validates HMAC-SHA512 signatures over the raw body', () => {
    const p = new PaystackProvider(SECRET);
    const body = '{"event":"charge.success","data":{"reference":"R1"}}';
    expect(p.parseWebhook(Buffer.from(body), { 'x-paystack-signature': sign(body) })?.reference).toBe('R1');
    expect(p.parseWebhook(Buffer.from(body), { 'x-paystack-signature': sign(body + ' ') })).toBeNull();
    expect(p.parseWebhook(Buffer.from(body), {})).toBeNull();
  });
});

describe('Paystack webhook endpoint', () => {
  let ctx: Awaited<ReturnType<typeof createTestContext>>;
  afterEach(() => ctx.close());

  it('rejects bad signatures and grants access exactly once for repeated valid events', async () => {
    const fake = fakePaystack();
    ctx = await createTestContext({
      payments: new PaystackProvider(SECRET, 'https://api.paystack.co', fake.fetchImpl as typeof fetch),
    });

    const customer = await signUp(ctx.app, '+234 803 123 4567');
    const order = await customer.post('/api/orders').send({ planId: ctx.plan.id }).expect(201);
    const reference = order.body.reference as string;
    expect(order.body.authorizationUrl).toMatch(/^https:\/\/checkout\.paystack\.com\//);

    const body = JSON.stringify({ event: 'charge.success', data: { reference } });

    await request(ctx.app)
      .post('/api/webhooks/paystack')
      .set('content-type', 'application/json')
      .set('x-paystack-signature', 'forged')
      .send(body)
      .expect(401);

    // Signed webhook, but Paystack's verify still says "ongoing": no access yet.
    await request(ctx.app)
      .post('/api/webhooks/paystack')
      .set('content-type', 'application/json')
      .set('x-paystack-signature', sign(body))
      .send(body)
      .expect(200);
    expect(await ctx.deps.db.select().from(accessSessions)).toHaveLength(0);

    fake.txns.get(reference)!.status = 'success';
    for (let i = 0; i < 3; i++) {
      await request(ctx.app)
        .post('/api/webhooks/paystack')
        .set('content-type', 'application/json')
        .set('x-paystack-signature', sign(body))
        .send(body)
        .expect(200);
    }
    // Provisioning runs in the background after the webhook; let it finish.
    await ctx.sessions.retryPending();
    const sessions = await ctx.deps.db.select().from(accessSessions);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.status).toBe('active');
  });
});
