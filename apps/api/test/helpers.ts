import request from 'supertest';
import path from 'node:path';
import { createApp } from '../src/app';
import { loadConfig } from '../src/config';
import { createDatabase } from '../src/db/client';
import { admins, plans } from '../src/db/schema';
import type { Deps } from '../src/deps';
import { createLogger } from '../src/lib/logger';
import { hashPassword } from '../src/lib/password';
import { MockMailService } from '../src/mail/mock';
import { MockNetworkService } from '../src/network/mock';
import { MockPaymentProvider } from '../src/payments/mock';
import type { PaymentProvider } from '../src/payments/provider';

export const MIGRATIONS = path.resolve(__dirname, '../drizzle');

export async function createTestContext(opts: { payments?: PaymentProvider; env?: Record<string, string> } = {}) {
  const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', ...opts.env });
  const database = await createDatabase({ pgliteDir: 'memory://' });
  await database.migrate(MIGRATIONS);

  // Real time, because the mock payment provider stamps paidAt with the real clock.
  let now = new Date();
  const clock = {
    now: () => now,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };

  const network = new MockNetworkService();
  const mail = new MockMailService();
  const payments = opts.payments ?? new MockPaymentProvider(config.PUBLIC_PORTAL_URL);
  const deps: Deps = {
    config,
    db: database.db,
    logger: createLogger('silent', false),
    payments,
    network,
    mail,
    now: clock.now,
  };
  const built = createApp(deps);

  const [hourPlan, , bundlePlan] = await database.db
    .insert(plans)
    .values([
      { name: '1 Hour', priceKobo: 10_000, durationMinutes: 60, rateLimit: '5M/5M', sortOrder: 1 },
      { name: '24 Hours', priceKobo: 50_000, durationMinutes: 1440, sortOrder: 2 },
      { name: '1 GB Monthly', priceKobo: 100_000, durationMinutes: 30 * 1440, dataCapMb: 1024, sortOrder: 3 },
    ])
    .returning();

  await database.db
    .insert(admins)
    .values({ email: 'admin@example.com', passwordHash: await hashPassword('correct-horse-battery') });

  return { ...built, deps, network, mail, payments, clock, plan: hourPlan!, bundlePlan: bundlePlan!, close: database.close };
}

/** Registers a customer and returns a supertest agent that carries their sign-in cookie. */
export async function signUp(app: Parameters<typeof request.agent>[0], phone = '08031234567', password = 'customer-pass-1') {
  const agent = request.agent(app);
  const email = `${phone.replace(/\D/g, '')}@example.com`;
  const res = await agent.post('/api/auth/register').send({ phone, password, email });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  return agent;
}
