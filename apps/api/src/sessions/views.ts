import type { SessionView } from '@yourwifi/shared';
import type { accessSessions } from '../db/schema';

export function toSessionView(s: typeof accessSessions.$inferSelect): SessionView {
  return {
    voucherCode: s.voucherCode,
    status: s.status,
    planName: s.planName,
    startsAt: s.startsAt?.toISOString() ?? null,
    expiresAt: s.expiresAt?.toISOString() ?? null,
    durationMinutes: s.durationMinutes,
    dataCapMb: s.dataCapMb,
    bytesUsed: s.bytesUsed,
    usageUpdatedAt: s.usageUpdatedAt?.toISOString() ?? null,
  };
}
