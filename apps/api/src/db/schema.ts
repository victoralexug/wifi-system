import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

export const orderStatus = pgEnum('order_status', ['pending', 'success', 'failed', 'flagged']);
// expired = time ran out; exhausted = data bundle used up.
export const sessionStatus = pgEnum('session_status', ['pending', 'active', 'expired', 'exhausted', 'revoked']);
export const deviceStatus = pgEnum('device_status', ['unknown', 'online', 'offline']);

export const plans = pgTable('plans', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  priceKobo: integer('price_kobo').notNull(),
  durationMinutes: integer('duration_minutes').notNull(),
  // RouterOS rate-limit syntax, e.g. "5M/5M" (rx/tx). Null means unlimited.
  rateLimit: text('rate_limit'),
  dataCapMb: integer('data_cap_mb'),
  active: boolean('active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  ...timestamps,
});

export const customers = pgTable('customers', {
  id: uuid('id').primaryKey().defaultRandom(),
  // E.164, e.g. +2348012345678
  phone: text('phone').notNull().unique(),
  name: text('name'),
  email: text('email'),
  // Null for customers created before accounts existed; they set one by registering.
  passwordHash: text('password_hash'),
  ...timestamps,
});

export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Our reference, sent to Paystack. Unique, so one payment maps to exactly one order.
    reference: text('reference').notNull().unique(),
    customerId: uuid('customer_id').notNull().references(() => customers.id),
    planId: uuid('plan_id').notNull().references(() => plans.id),
    amountKobo: integer('amount_kobo').notNull(),
    currency: text('currency').notNull().default('NGN'),
    status: orderStatus('status').notNull().default('pending'),
    email: text('email').notNull(),
    deviceMac: text('device_mac'),
    deviceIp: text('device_ip'),
    failureReason: text('failure_reason'),
    providerPayload: jsonb('provider_payload'),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index('orders_status_idx').on(t.status), index('orders_created_at_idx').on(t.createdAt)],
);

export const accessSessions = pgTable(
  'access_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Unique: a paid order can never produce two sessions, even if webhooks repeat.
    orderId: uuid('order_id').notNull().unique().references(() => orders.id),
    customerId: uuid('customer_id').notNull().references(() => customers.id),
    planId: uuid('plan_id').notNull().references(() => plans.id),
    // Doubles as the hotspot username and password on the controller.
    voucherCode: text('voucher_code').notNull().unique(),
    status: sessionStatus('status').notNull().default('pending'),
    // Snapshot of the plan at purchase time, so later plan edits don't change paid sessions.
    planName: text('plan_name').notNull(),
    durationMinutes: integer('duration_minutes').notNull(),
    rateLimit: text('rate_limit'),
    dataCapMb: integer('data_cap_mb'),
    startsAt: timestamp('starts_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    controllerRef: text('controller_ref'),
    // Total bytes up + down, as last read from the controller.
    bytesUsed: bigint('bytes_used', { mode: 'number' }).notNull().default(0),
    usageUpdatedAt: timestamp('usage_updated_at', { withTimezone: true }),
    // Last raw counter read from the controller. Usage grows by the difference between reads,
    // so a counter reset (router reboot, user re-created) never makes usage go backwards.
    controllerBytes: bigint('controller_bytes', { mode: 'number' }).notNull().default(0),
    provisionAttempts: integer('provision_attempts').notNull().default(0),
    lastError: text('last_error'),
    ...timestamps,
  },
  (t) => [index('access_sessions_status_expires_idx').on(t.status, t.expiresAt)],
);

export const networkDevices = pgTable('network_devices', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  driver: text('driver').notNull(),
  status: deviceStatus('status').notNull().default('unknown'),
  identity: text('identity'),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  lastError: text('last_error'),
  ...timestamps,
});

export const admins = pgTable('admins', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  ...timestamps,
});

export const webhookEvents = pgTable('webhook_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  provider: text('provider').notNull(),
  event: text('event'),
  reference: text('reference'),
  signatureValid: boolean('signature_valid').notNull(),
  payload: jsonb('payload'),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
});
