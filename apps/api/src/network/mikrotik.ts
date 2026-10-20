import type { ActiveConnection } from '@yourwifi/shared';
import { Agent, fetch as undiciFetch } from 'undici';
import type { GrantAccessInput, HealthResult, NetworkService } from './networkService';

type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
    dispatcher?: Agent;
  },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface MikrotikOptions {
  /** Base URL of the router's REST API, e.g. https://10.8.0.2 (the /rest prefix is added). */
  url: string;
  user: string;
  password: string;
  /** Hotspot server name the users belong to; "all" matches every server. */
  hotspotServer: string;
  /** Accept the router's self-signed certificate. Only use over a private tunnel. */
  insecureTls: boolean;
  fetchImpl?: FetchLike;
}

type RouterRecord = Record<string, string> & { '.id': string };

/**
 * Talks to RouterOS v7 through its REST API (/rest/...), using Hotspot users as vouchers.
 * Every paid session becomes one hotspot user whose username and password are the voucher code.
 * The user's profile carries the speed limit and allows one device at a time.
 */
export class MikrotikNetworkService implements NetworkService {
  readonly driver = 'mikrotik' as const;
  private readonly base: string;
  private readonly auth: string;
  private readonly dispatcher?: Agent;
  private readonly fetchImpl: FetchLike;
  private readonly knownProfiles = new Set<string>();

  constructor(private readonly opts: MikrotikOptions) {
    this.base = opts.url.replace(/\/+$/, '') + '/rest';
    this.auth = 'Basic ' + Buffer.from(`${opts.user}:${opts.password}`).toString('base64');
    if (opts.insecureTls) this.dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
    this.fetchImpl = opts.fetchImpl ?? (undiciFetch as unknown as FetchLike);
  }

  async grantAccess(input: GrantAccessInput) {
    const profile = await this.ensureProfile(input.rateLimit);
    const fields: Record<string, string> = {
      server: this.opts.hotspotServer,
      name: input.username,
      password: input.password,
      profile,
      // Caps connected time as a safety net. The backend expiry job enforces wall-clock expiry.
      'limit-uptime': toRouterOsDuration(input.durationMinutes),
      'limit-bytes-total': input.dataCapMb ? String(input.dataCapMb * 1024 * 1024) : '0',
      comment: input.comment ?? '',
    };
    const existing = await this.findOne('/ip/hotspot/user', { name: input.username });
    if (existing) {
      await this.call('PATCH', `/ip/hotspot/user/${existing['.id']}`, fields);
      return { controllerRef: existing['.id'] };
    }
    const created = (await this.call('PUT', '/ip/hotspot/user', fields)) as RouterRecord;
    return { controllerRef: created['.id'] };
  }

  async revokeAccess(username: string) {
    // Kick live connections and MAC cookies first so the device can't silently re-authenticate.
    for (const active of await this.list('/ip/hotspot/active', { user: username })) {
      await this.call('DELETE', `/ip/hotspot/active/${active['.id']}`);
    }
    for (const cookie of await this.list('/ip/hotspot/cookie', { user: username })) {
      await this.call('DELETE', `/ip/hotspot/cookie/${cookie['.id']}`);
    }
    const user = await this.findOne('/ip/hotspot/user', { name: username });
    if (user) await this.call('DELETE', `/ip/hotspot/user/${user['.id']}`);
  }

  async listActive(): Promise<ActiveConnection[]> {
    const rows = await this.list('/ip/hotspot/active');
    return rows.map((r) => ({
      user: r.user ?? '',
      address: r.address ?? null,
      macAddress: r['mac-address'] ?? null,
      uptime: r.uptime ?? null,
      bytesIn: r['bytes-in'] ? Number(r['bytes-in']) : null,
      bytesOut: r['bytes-out'] ? Number(r['bytes-out']) : null,
    }));
  }

  /**
   * RouterOS only folds traffic into a hotspot user's bytes-in/bytes-out when a session ends,
   * so live usage is (saved user totals) + (current counters from /ip/hotspot/active).
   * Two requests per poll, however many customers are connected.
   */
  async getUsage(): Promise<Map<string, number>> {
    const [users, active] = await Promise.all([this.list('/ip/hotspot/user'), this.list('/ip/hotspot/active')]);
    const usage = new Map<string, number>();
    for (const u of users) usage.set(u.name ?? '', num(u['bytes-in']) + num(u['bytes-out']));
    for (const a of active) {
      const name = a.user ?? '';
      usage.set(name, (usage.get(name) ?? 0) + num(a['bytes-in']) + num(a['bytes-out']));
    }
    return usage;
  }

  async healthCheck(): Promise<HealthResult> {
    try {
      const identity = (await this.call('GET', '/system/identity')) as { name?: string };
      return { ok: true, identity: identity.name };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }

  private async ensureProfile(rateLimit: string | null): Promise<string> {
    const name = rateLimit ? `yw-${rateLimit.replace(/[^0-9A-Za-z]+/g, '-')}` : 'yw-unlimited';
    if (this.knownProfiles.has(name)) return name;
    const fields: Record<string, string> = {
      name,
      'shared-users': '1',
      'rate-limit': rateLimit ?? '',
      'add-mac-cookie': 'yes',
      'mac-cookie-timeout': '1d',
    };
    const existing = await this.findOne('/ip/hotspot/user/profile', { name });
    if (existing) await this.call('PATCH', `/ip/hotspot/user/profile/${existing['.id']}`, fields);
    else await this.call('PUT', '/ip/hotspot/user/profile', fields);
    this.knownProfiles.add(name);
    return name;
  }

  private async list(path: string, filter?: Record<string, string>): Promise<RouterRecord[]> {
    const qs = filter ? '?' + new URLSearchParams(filter).toString() : '';
    return (await this.call('GET', path + qs)) as RouterRecord[];
  }

  private async findOne(path: string, filter: Record<string, string>) {
    const rows = await this.list(path, filter);
    return rows[0] ?? null;
  }

  private async call(method: 'GET' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<unknown> {
    const res = await this.fetchImpl(this.base + path, {
      method,
      headers: { Authorization: this.auth, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
      dispatcher: this.dispatcher,
    });
    const text = await res.text();
    if (!res.ok) {
      let detail = text;
      try {
        const j = JSON.parse(text) as { message?: string; detail?: string };
        detail = [j.message, j.detail].filter(Boolean).join(': ');
      } catch {
        // keep raw text
      }
      throw new Error(`RouterOS ${method} ${path} failed (${res.status}): ${detail}`);
    }
    return text ? JSON.parse(text) : null;
  }
}

const num = (v: string | undefined) => (v ? Number(v) || 0 : 0);

/** 90 → "1h30m", 1440 → "1d", 10080 → "7d". */
export function toRouterOsDuration(minutes: number): string {
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  return [d && `${d}d`, h && `${h}h`, m && `${m}m`].filter(Boolean).join('') || '0m';
}
