import path from 'node:path';
import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const csv = z
  .string()
  .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  TRUST_PROXY: bool.default(false),

  // Postgres connection string. When unset, an embedded PGlite database is used (dev only).
  DATABASE_URL: z.string().optional(),
  PGLITE_DIR: z.string().default('.data/pglite'),
  MIGRATIONS_DIR: z.string().default(path.resolve(process.cwd(), 'drizzle')),

  // Where the customer portal is served. Paystack redirects here after checkout.
  PUBLIC_PORTAL_URL: z.url().default('http://localhost:5173'),
  CORS_ORIGINS: csv.default(['http://localhost:5173', 'http://localhost:5174']),
  SERVE_STATIC: bool.default(false),

  PAYMENT_DRIVER: z.enum(['mock', 'paystack']).default('mock'),
  PAYSTACK_SECRET_KEY: z.string().optional(),
  PAYSTACK_BASE_URL: z.url().default('https://api.paystack.co'),
  // Paystack requires an email; older accounts without one get <phone>@<this domain>.
  PLACEHOLDER_EMAIL_DOMAIN: z.string().default('customers.yourwifi.ng'),

  ADMIN_JWT_SECRET: z.string().min(32).optional(),

  // mock = log emails instead of sending them (dev and tests). smtp = send through SMTP_URL.
  MAIL_DRIVER: z.enum(['mock', 'smtp']).default('mock'),
  // e.g. smtps://user:password@smtp.example.com:465
  SMTP_URL: z.string().optional(),
  MAIL_FROM: z.string().default('YourWiFi <no-reply@yourwifi.ng>'),

  // How often pending payments are re-checked with Paystack, in case a webhook never arrived.
  RECONCILE_INTERVAL_SECONDS: z.coerce.number().int().positive().default(120),

  // Day of the month (Lagos time) when new voucher codes are generated, topping each plan up to its stock target.
  VOUCHER_GENERATION_DAY: z.coerce.number().int().min(1).max(28).default(1),
  // Lets the router collect generated voucher batches (infra/mikrotik/). Unset = admins deliver them by hand.
  ROUTER_TOKEN: z.string().min(32).optional(),
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  // `KEY=` lines in .env mean "not set", not "set to an empty string".
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ''));
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const c = parsed.data;
  const problems: string[] = [];
  const isProd = c.NODE_ENV === 'production';

  if (isProd) {
    // Simulated payments must never reach real customers.
    if (c.PAYMENT_DRIVER === 'mock') problems.push('PAYMENT_DRIVER=mock is not allowed in production');
    // Password reset links have to actually reach customers.
    if (c.MAIL_DRIVER === 'mock') problems.push('MAIL_DRIVER=mock is not allowed in production');
    if (!c.DATABASE_URL) problems.push('DATABASE_URL is required in production');
    if (!c.ADMIN_JWT_SECRET) problems.push('ADMIN_JWT_SECRET is required in production');
    if (c.PAYSTACK_SECRET_KEY?.startsWith('sk_test_')) {
      problems.push('PAYSTACK_SECRET_KEY is a test key; use a live key in production');
    }
  }
  if (c.PAYMENT_DRIVER === 'paystack' && !c.PAYSTACK_SECRET_KEY) {
    problems.push('PAYSTACK_SECRET_KEY is required when PAYMENT_DRIVER=paystack');
  } else if (c.PAYMENT_DRIVER === 'paystack' && !/^sk_(test|live)_\w+$/.test(c.PAYSTACK_SECRET_KEY!)) {
    problems.push('PAYSTACK_SECRET_KEY must be a Paystack secret key (sk_test_… or sk_live_…), not the public pk_ key');
  }
  if (c.MAIL_DRIVER === 'smtp' && !c.SMTP_URL) {
    problems.push('SMTP_URL is required when MAIL_DRIVER=smtp');
  }
  if (problems.length) {
    throw new Error(`Invalid environment configuration:\n${problems.map((p) => `  ${p}`).join('\n')}`);
  }

  return {
    ...c,
    isProd,
    // Dev-only fallback so the admin dashboard works out of the box locally.
    ADMIN_JWT_SECRET: c.ADMIN_JWT_SECRET ?? 'dev-only-insecure-secret-change-me-0123456789',
  };
}
