import { loadConfig } from '../config';
import { createDatabase } from '../db/client';
import { plans } from '../db/schema';

const GB = 1024;
const DAY = 24 * 60;

// Starter catalogue. PRICES ARE PLACEHOLDERS: set real ones in the admin dashboard (Plans).
// Time passes have no data cap; bundles end when either the data or the time runs out.
export const DEFAULT_PLANS = [
  { name: '1 Hour', description: 'Unlimited browsing for one hour', priceKobo: 100_00, durationMinutes: 60, rateLimit: '5M/5M', dataCapMb: null, sortOrder: 1 },
  { name: '24 Hours', description: 'Unlimited browsing for one day', priceKobo: 500_00, durationMinutes: DAY, rateLimit: '5M/5M', dataCapMb: null, sortOrder: 2 },
  { name: '7 Days', description: 'Unlimited browsing for one week', priceKobo: 2_000_00, durationMinutes: 7 * DAY, rateLimit: '5M/5M', dataCapMb: null, sortOrder: 3 },
  { name: '10 GB Monthly', description: '10 GB to use within 30 days', priceKobo: 3_500_00, durationMinutes: 30 * DAY, rateLimit: '10M/10M', dataCapMb: 10 * GB, sortOrder: 10 },
  { name: '30 GB Monthly', description: '30 GB to use within 30 days', priceKobo: 8_000_00, durationMinutes: 30 * DAY, rateLimit: '10M/10M', dataCapMb: 30 * GB, sortOrder: 11 },
  { name: '60 GB Monthly', description: '60 GB to use within 30 days', priceKobo: 14_000_00, durationMinutes: 30 * DAY, rateLimit: '10M/10M', dataCapMb: 60 * GB, sortOrder: 12 },
  { name: '100 GB Monthly', description: '100 GB to use within 30 days', priceKobo: 20_000_00, durationMinutes: 30 * DAY, rateLimit: '10M/10M', dataCapMb: 100 * GB, sortOrder: 13 },
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
