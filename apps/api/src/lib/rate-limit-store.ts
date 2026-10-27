import { eq, lte, sql } from 'drizzle-orm';
import type { ClientRateLimitInfo, Options, Store } from 'express-rate-limit';
import type { Database } from '../db/client';
import { rateLimits } from '../db/schema';

/**
 * express-rate-limit store backed by Postgres. On Netlify Functions each request may land on a
 * different instance, so in-memory counters would barely limit anything.
 */
export class PgRateLimitStore implements Store {
  private windowMs = 60_000;

  /** `prefix` keeps each limiter's counters apart in the shared table. */
  constructor(
    private readonly db: Database,
    readonly prefix: string,
  ) {}

  init(options: Options) {
    this.windowMs = options.windowMs;
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    const resetAt = new Date(Date.now() + this.windowMs);
    const expired = sql`${rateLimits.resetAt} <= now()`;
    const [row] = await this.db
      .insert(rateLimits)
      .values({ key: this.prefix + key, hits: 1, resetAt })
      .onConflictDoUpdate({
        target: rateLimits.key,
        set: {
          hits: sql`case when ${expired} then 1 else ${rateLimits.hits} + 1 end`,
          resetAt: sql`case when ${expired} then excluded.reset_at else ${rateLimits.resetAt} end`,
        },
      })
      .returning();
    return { totalHits: row!.hits, resetTime: row!.resetAt };
  }

  async decrement(key: string) {
    await this.db
      .update(rateLimits)
      .set({ hits: sql`greatest(${rateLimits.hits} - 1, 0)` })
      .where(eq(rateLimits.key, this.prefix + key));
  }

  async resetKey(key: string) {
    await this.db.delete(rateLimits).where(eq(rateLimits.key, this.prefix + key));
  }
}

/** Removes expired counters. Run from the background jobs. */
export async function pruneRateLimits(db: Database) {
  await db.delete(rateLimits).where(lte(rateLimits.resetAt, sql`now()`));
}
