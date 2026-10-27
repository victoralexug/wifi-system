import {
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

export const plans = pgTable('plans', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  priceKobo: integer('price_kobo').notNull(),
  durationMinutes: integer('duration_minutes').notNull(),
  // Null means unlimited data (a time pass).
  dataCapMb: integer('data_cap_mb'),
  active: boolean('active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  // The monthly voucher job tops unused codes up to this many. 0 = no generated codes for this plan.
  voucherStockTarget: integer('voucher_stock_target').notNull().default(0),
  ...timestamps,
});

export const customers = pgTable('customers', {
  id: uuid('id').primaryKey().defaultRandom(),
  // E.164, e.g. +2348012345678
  phone: text('phone').notNull().unique(),
  name: text('name'),
  // Lowercased. Required at sign-up and used for password reset; null only on older accounts.
  email: text('email').unique(),
  // Null for customers created before accounts existed; they set one by registering.
  passwordHash: text('password_hash'),
  ...timestamps,
});

export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerId: uuid('customer_id').notNull().references(() => customers.id),
    // SHA-256 of the token in the emailed link. The token itself is never stored.
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('password_reset_tokens_customer_idx').on(t.customerId)],
);

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
    failureReason: text('failure_reason'),
    providerPayload: jsonb('provider_payload'),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index('orders_status_idx').on(t.status), index('orders_created_at_idx').on(t.createdAt)],
);

/**
 * Codes the system generated together, to be loaded on the router. Until the batch is marked
 * ready (by the router collecting it, or an admin), its codes aren't sold.
 */
export const voucherBatches = pgTable('voucher_batches', {
  id: uuid('id').primaryKey().defaultRandom(),
  // "YYYY-MM" for the monthly job, so each month gets at most one scheduled batch. Null for manual ones.
  period: text('period').unique(),
  codeCount: integer('code_count').notNull(),
  readyAt: timestamp('ready_at', { withTimezone: true }),
  // 'router' (collected by the router's script) or the admin's email.
  readyBy: text('ready_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Voucher codes for each plan, uploaded by an admin or generated in a batch. When an order for that plan is paid, it is given
 * the next unused code, which the customer then sees.
 */
export const vouchers = pgTable(
  'vouchers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    planId: uuid('plan_id').notNull().references(() => plans.id),
    code: text('code').notNull().unique(),
    batchId: uuid('batch_id').references(() => voucherBatches.id),
    // When the code became usable on the router, and so sellable. Uploaded codes are ready at once.
    readyAt: timestamp('ready_at', { withTimezone: true }),
    // Set once, when the voucher is given to a paid order. Unique: an order gets exactly one voucher.
    orderId: uuid('order_id').unique().references(() => orders.id),
    assignedAt: timestamp('assigned_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('vouchers_plan_unused_idx').on(t.planId, t.orderId)],
);

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

// Rate-limit counters, kept in the database because serverless instances share no memory.
export const rateLimits = pgTable('rate_limits', {
  key: text('key').primaryKey(),
  hits: integer('hits').notNull(),
  resetAt: timestamp('reset_at', { withTimezone: true }).notNull(),
});
