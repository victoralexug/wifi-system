import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { parseRouterOsDuration, parseUsageReport } from '../src/vouchers/usage';
import { createTestContext, signUp } from './helpers';

type Ctx = Awaited<ReturnType<typeof createTestContext>>;
const ROUTER_TOKEN = 'test-router-token-0123456789abcdef0123';
const GB = 1024 * 1024 * 1024;
const DAY = 86_400_000;

describe('voucher usage and expiry', () => {
  let ctx: Ctx;
  afterEach(() => ctx?.close());

  const router = () => ({ Authorization: `Bearer ${ROUTER_TOKEN}` });
  const report = (body: string) => request(ctx.app).post('/api/router/usage').set(router()).type('text/plain').send(body);

  const buyBundle = async () => {
    const customer = await signUp(ctx.app);
    const { body } = await customer.post('/api/orders').send({ planId: ctx.bundlePlan.id }).expect(201);
    const paid = await request(ctx.app).post(`/api/dev/mock-pay/${body.reference}`).send({ outcome: 'success' }).expect(200);
    const mine = async () => (await customer.get('/api/me/orders').expect(200)).body[0];
    return { code: paid.body.voucherCode as string, mine };
  };

  it('reads RouterOS times and skips lines it cannot read', () => {
    expect(parseRouterOsDuration('00:05:12')).toBe(312);
    expect(parseRouterOsDuration('1d02:00:00')).toBe(93_600);
    expect(parseRouterOsDuration('1w2d03:04:05')).toBe(788_645);
    expect(parseRouterOsDuration('3d')).toBe(259_200);
    expect(parseRouterOsDuration('soon')).toBeNull();
    expect(parseUsageReport('u,AB12,01:00:00,500\nx,CD34,01:00:00,1\na,EF56,later,1\n\na,GH78,00:00:30,20')).toEqual([
      { kind: 'u', code: 'AB12', seconds: 3600, bytes: 500 },
      { kind: 'a', code: 'GH78', seconds: 30, bytes: 20 },
    ]);
  });

  it('shows the buyer the data left once the router reports', async () => {
    ctx = await createTestContext({ env: { ROUTER_TOKEN } });
    const { code, mine } = await buyBundle(); // 1 GB, 30 days

    expect(await mine()).toMatchObject({ state: 'active', usage: null }); // no report yet
    await request(ctx.app).post('/api/router/usage').type('text/plain').send('').expect(401);

    await report('').expect(204);
    expect(await mine()).toMatchObject({ state: 'unused', usage: { online: false, bytesLeft: GB } });

    // Online now: a session of 256 MB, on top of nothing finished yet.
    await report(`a,${code},01:00:00,${GB / 4}`).expect(204);
    expect(await mine()).toMatchObject({ state: 'active', usage: { online: true, bytesLeft: (GB * 3) / 4 } });

    // The session ended and the user's counters include it: it isn't counted twice.
    await report(`u,${code},01:30:00,${GB / 2}`).expect(204);
    expect(await mine()).toMatchObject({ state: 'active', usage: { online: false, bytesLeft: GB / 2 } });

    await report(`u,${code},02:00:00,${GB}`).expect(204);
    expect(await mine()).toMatchObject({ state: 'used_up', usage: { bytesLeft: 0 } });
  });

  it('stops counting a session the router no longer reports', async () => {
    ctx = await createTestContext({ env: { ROUTER_TOKEN } });
    const { code, mine } = await buyBundle();
    await report(`a,${code},00:10:00,1000`).expect(204);
    ctx.clock.advance(30 * 60_000);
    await report('').expect(204);
    expect(await mine()).toMatchObject({ state: 'active', usage: { online: false, bytesUsed: 0 } });
  });

  it("expires a code its plan's duration after purchase, used or not, and has the router remove it", async () => {
    ctx = await createTestContext({ env: { ROUTER_TOKEN } });
    const bought = ctx.clock.now();
    const { code, mine } = await buyBundle(); // 30 days
    expect(new Date((await mine()).expiresAt).getTime()).toBe(bought.getTime() + 30 * DAY);
    expect((await request(ctx.app).get('/api/router/expired.rsc').set(router()).expect(200)).text).toContain('no expired');

    ctx.clock.advance(30 * DAY - 60_000);
    expect((await mine()).state).toBe('active');
    ctx.clock.advance(60_000);
    expect((await mine()).state).toBe('expired');

    const script = (await request(ctx.app).get('/api/router/expired.rsc').set(router()).expect(200)).text;
    expect(script).toContain(`/ip hotspot active remove [find user="${code}"]`);
    expect(script).toContain(`/ip hotspot user remove [find name="${code}"]`);
    const ack = script.match(/url="[^"]*(\/api\/router\/expired\/ack\?before=[^"]+)"/)![1]!;
    await request(ctx.app).post(ack).expect(401);
    await request(ctx.app).post(ack).set(router()).expect(204);
    expect((await request(ctx.app).get('/api/router/expired.rsc').set(router()).expect(200)).text).toContain('no expired');
    expect((await mine()).state).toBe('expired');
  });
});
