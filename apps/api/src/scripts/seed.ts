import { loadConfig } from '../config';
import { createDatabase } from '../db/client';
import { plans } from '../db/schema';

const GB = 1024;
const DAY = 24 * 60;

// Starter catalogue. voucherStockTarget is how many of each plan can be sold per month: the
// monthly batch only tops stock up to it, so the data bundles add up to 4,600 GB a month,
// sized to stay inside a 5 TB Starlink plan. The unlimited passes (dataCapMb null) aren't
// in that total. Change any of it later in the admin dashboard.
export const DEFAULT_PLANS = [
  { name: '1 GB Daily', description: '1 GB to use within 1 day', priceKobo: 150_00, durationMinutes: DAY, dataCapMb: 1 * GB, voucherStockTarget: 200, sortOrder: 1 },
  { name: '10 GB Weekly', description: '10 GB to use within 1 week', priceKobo: 3_000_00, durationMinutes: 7 * DAY, dataCapMb: 10 * GB, voucherStockTarget: 60, sortOrder: 2 },
  { name: '30 GB, 2 Weeks', description: '30 GB to use within 2 weeks', priceKobo: 5_000_00, durationMinutes: 14 * DAY, dataCapMb: 30 * GB, voucherStockTarget: 20, sortOrder: 3 },
  { name: '60 GB Monthly', description: '60 GB to use within 30 days', priceKobo: 7_000_00, durationMinutes: 30 * DAY, dataCapMb: 60 * GB, voucherStockTarget: 20, sortOrder: 4 },
  { name: '100 GB Monthly', description: '100 GB to use within 30 days', priceKobo: 10_000_00, durationMinutes: 30 * DAY, dataCapMb: 100 * GB, voucherStockTarget: 20, sortOrder: 5 },
  { name: 'Unlimited Weekly', description: 'Unlimited data for 1 week', priceKobo: 5_000_00, durationMinutes: 7 * DAY, dataCapMb: null, voucherStockTarget: 20, sortOrder: 6 },
  { name: 'Unlimited Monthly', description: 'Unlimited data for 30 days', priceKobo: 20_000_00, durationMinutes: 30 * DAY, dataCapMb: null, voucherStockTarget: 5, sortOrder: 7 },
];

const config = loadConfig();
const database = await createDatabase({ databaseUrl: config.DATABASE_URL, pgliteDir: config.PGLITE_DIR });
await database.migrate(config.MIGRATIONS_DIR);

// Adds any default plan whose name isn't taken yet, so re-running never duplicates or overwrites.
const existing = new Set((await database.db.select({ name: plans.name }).from(plans)).map((p) => p.name));
const missing = DEFAULT_PLANS.filter((p) => !existing.has(p.name));
if (missing.length) await database.db.insert(plans).values(missing);
console.log(missing.length ? `Added ${missing.length} plans: ${missing.map((p) => p.name).join(', ')}` : 'All default plans already exist.');
await database.close();
