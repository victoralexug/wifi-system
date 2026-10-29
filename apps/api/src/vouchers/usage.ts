import type { VoucherUsage } from '@yourwifi/shared';
import { eq, sql } from 'drizzle-orm';
import type { Database } from '../db/client';
import { routerReports, vouchers } from '../db/schema';

/**
 * Voucher usage reported by the router (infra/mikrotik/yourwifi-voucher-sync.rsc, every 15 min).
 * The body is plain text, one code per line:
 *   u,<code>,<uptime>,<bytes>   the hotspot user's counters (finished sessions)
 *   a,<code>,<uptime>,<bytes>   a session in progress
 * where uptime is RouterOS time ("1w2d03:04:05") and bytes is bytes in + out.
 */
export interface UsageLine {
  kind: 'u' | 'a';
  code: string;
  seconds: number;
  bytes: number;
}

// A session counts as in progress until a little after the next report is due.
const ONLINE_WINDOW_MS = 20 * 60_000;
const MAX_LINES = 500;

/** "1w2d03:04:05" → 788645. Also accepts "03:04:05", "2d03:04:05" and a fraction of a second. */
export function parseRouterOsDuration(s: string): number | null {
  const m = /^(?:(\d+)w)?(?:(\d+)d)?(?:(\d+):(\d{2}):(\d{2})(?:\.\d+)?)?$/.exec(s.trim());
  if (!m || !s.trim()) return null;
  const [, w = '0', d = '0', h = '0', min = '0', sec = '0'] = m;
  return ((+w * 7 + +d) * 24 + +h) * 3600 + +min * 60 + +sec;
}

/** Lines that don't parse are skipped, so one odd entry can't block the rest of a report. */
export function parseUsageReport(body: string): UsageLine[] {
  const lines: UsageLine[] = [];
  for (const raw of body.split(/\r?\n/).slice(0, MAX_LINES)) {
    const [kind, code, uptime, bytes] = raw.trim().split(',');
    if ((kind !== 'u' && kind !== 'a') || !code) continue;
    const seconds = parseRouterOsDuration(uptime ?? '');
    const total = Number(bytes);
    if (seconds === null || !Number.isSafeInteger(total) || total < 0) continue;
    lines.push({ kind, code, seconds, bytes: total });
  }
  return lines;
}

export async function recordUsage(db: Database, lines: UsageLine[], now: Date): Promise<void> {
  await db.transaction(async (tx) => {
    for (const l of lines) {
      const firstUsedAt = sql`coalesce(${vouchers.firstUsedAt}, ${now})`;
      // When the user's counters go up, the session they include has ended: drop it, or it would
      // be counted twice until it times out. The router sends `u` lines before `a` lines.
      const ended = sql`${l.seconds} > ${vouchers.usedSeconds}`;
      await tx
        .update(vouchers)
        .set(
          l.kind === 'u'
            ? {
                usedSeconds: l.seconds,
                usedBytes: l.bytes,
                firstUsedAt,
                sessionSeconds: sql`case when ${ended} then 0 else ${vouchers.sessionSeconds} end`,
                sessionBytes: sql`case when ${ended} then 0 else ${vouchers.sessionBytes} end`,
                onlineAt: sql`case when ${ended} then null else ${vouchers.onlineAt} end`,
              }
            : { sessionSeconds: l.seconds, sessionBytes: l.bytes, onlineAt: now, firstUsedAt },
        )
        .where(eq(vouchers.code, l.code));
    }
    await tx
      .insert(routerReports)
      .values({ kind: 'usage', at: now })
      .onConflictDoUpdate({ target: routerReports.kind, set: { at: now } });
  });
}

export async function lastUsageReport(db: Database): Promise<Date | null> {
  const [row] = await db.select({ at: routerReports.at }).from(routerReports).where(eq(routerReports.kind, 'usage'));
  return row?.at ?? null;
}

type VoucherRow = Pick<
  typeof vouchers.$inferSelect,
  'expiresAt' | 'usedBytes' | 'sessionBytes' | 'onlineAt' | 'firstUsedAt'
>;

/** A sold code's state and data left. Expiry is known without the router; usage needs its reports. */
export function voucherStatus(
  v: VoucherRow,
  plan: { dataCapMb: number | null },
  checkedAt: Date | null,
  now: Date,
): { state: 'unused' | 'active' | 'expired' | 'used_up'; usage: VoucherUsage | null } {
  const expired = !!v.expiresAt && v.expiresAt <= now;
  if (!checkedAt) return { state: expired ? 'expired' : 'active', usage: null };
  const online = !expired && !!v.onlineAt && now.getTime() - v.onlineAt.getTime() < ONLINE_WINDOW_MS;
  const bytesUsed = v.usedBytes + (online ? v.sessionBytes : 0);
  const bytesLeft = plan.dataCapMb === null ? null : Math.max(0, plan.dataCapMb * 1024 * 1024 - bytesUsed);
  const state = expired ? 'expired' : bytesLeft === 0 ? 'used_up' : v.firstUsedAt ? 'active' : 'unused';
  return {
    state,
    usage: { online, bytesUsed, bytesLeft, firstUsedAt: v.firstUsedAt?.toISOString() ?? null, checkedAt: checkedAt.toISOString() },
  };
}
