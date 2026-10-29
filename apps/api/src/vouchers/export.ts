import type { plans } from '../db/schema';

type Row = { code: string; batchId: string | null; plan: typeof plans.$inferSelect };

const MB = 1024 * 1024;

/** One hotspot user profile per plan, named from its id so renaming a plan doesn't matter. */
export const profileName = (planId: string) => `yw-${planId.slice(0, 8)}`;

/** 90 → "1h30m", 1440 → "1d", 43200 → "30d". */
export function toRouterOsDuration(minutes: number): string {
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  return [d && `${d}d`, h && `${h}h`, m && `${m}m`].filter(Boolean).join('') || '0m';
}

const oneLine = (s: string) => s.replace(/[\r\n"\\$]/g, ' ');

export function toCsv(rows: Row[]): string {
  const cell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return ['code,plan,duration_minutes,data_cap_mb', ...rows.map((r) => [r.code, cell(r.plan.name), r.plan.durationMinutes, r.plan.dataCapMb ?? ''].join(','))].join('\n') + '\n';
}

/**
 * A RouterOS script that creates each code as a hotspot user (name and password are the code),
 * with its plan's limits. Importing it twice is harmless: codes that already exist are skipped.
 * `ackUrls` are fetched at the end, which tells the API the codes are on the router.
 */
export function toRouterOsScript(rows: Row[], opts: { generatedAt: Date; ackUrls?: string[]; token?: string }): string {
  const lines = [
    `# YourWiFi voucher codes: ${rows.length}, exported ${opts.generatedAt.toISOString()}.`,
    '# Import on the router (RouterOS v7):  /import file-name=<this file>',
    '# Each code becomes a hotspot user whose name and password are the code. Existing codes are skipped.',
    "# A code expires its plan's duration after purchase; the sync script removes it then. limit-uptime is a backstop.",
  ];
  const seen = new Set<string>();
  const planRows = rows.filter((r) => !seen.has(r.plan.id) && seen.add(r.plan.id));
  lines.push('/ip hotspot user profile');
  for (const { plan } of planRows) {
    const name = profileName(plan.id);
    lines.push(`# ${oneLine(plan.name)}`);
    lines.push(`:if ([:len [find name="${name}"]] = 0) do={ add name="${name}" shared-users=1 }`);
  }
  lines.push('/ip hotspot user');
  for (const { code, batchId, plan } of rows) {
    const limits = [
      `limit-uptime=${toRouterOsDuration(plan.durationMinutes)}`,
      plan.dataCapMb ? `limit-bytes-total=${plan.dataCapMb * MB}` : '',
    ]
      .filter(Boolean)
      .join(' ');
    lines.push(
      `:do { add name="${code}" password="${code}" profile="${profileName(plan.id)}" ${limits} comment="yourwifi batch ${batchId?.slice(0, 8) ?? ''}" } on-error={}`,
    );
  }
  for (const url of opts.ackUrls ?? []) {
    lines.push(`/tool fetch url="${url}" http-method=post http-header-field="Authorization: Bearer ${opts.token}" output=none`);
  }
  if (opts.ackUrls) lines.push(`:log info "yourwifi: loaded ${rows.length} voucher codes"`);
  return lines.join('\n') + '\n';
}

/**
 * A RouterOS script that logs out and removes expired codes. Removing a code that's already gone is
 * harmless. `ackUrl` is fetched at the end, which tells the API they're off the router.
 */
export function toExpiredScript(codes: string[], opts: { ackUrl: string; token: string }): string {
  const lines = [`# YourWiFi: ${codes.length} expired voucher codes to remove.`];
  for (const code of codes) {
    lines.push(`/ip hotspot active remove [find user="${code}"]`);
    lines.push(`/ip hotspot user remove [find name="${code}"]`);
  }
  lines.push(`/tool fetch url="${opts.ackUrl}" http-method=post http-header-field="Authorization: Bearer ${opts.token}" output=none`);
  lines.push(`:log info "yourwifi: removed ${codes.length} expired voucher codes"`);
  return lines.join('\n') + '\n';
}
