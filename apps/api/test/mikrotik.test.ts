import { describe, expect, it } from 'vitest';
import { MikrotikNetworkService, toRouterOsDuration } from '../src/network/mikrotik';

/** A tiny in-memory RouterOS REST API: just enough of /ip/hotspot to exercise the driver. */
function fakeRouter() {
  const tables: Record<string, Record<string, string>[]> = {
    '/ip/hotspot/user': [],
    '/ip/hotspot/user/profile': [],
    '/ip/hotspot/active': [],
    '/ip/hotspot/cookie': [],
  };
  let nextId = 1;
  const log: string[] = [];

  const fetchImpl = async (url: string, init: { method: string; body?: string; headers: Record<string, string> }) => {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/rest/, '');
    log.push(`${init.method} ${path}`);
    const ok = (v: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(v) });

    if (init.headers.Authorization !== 'Basic ' + Buffer.from('api:secret').toString('base64')) {
      return { ok: false, status: 401, text: async () => '{"message":"Unauthorized"}' };
    }
    if (path === '/system/identity') return ok({ name: 'YW-Router' });

    const idMatch = path.match(/^(.*)\/(\*\w+)$/);
    const table = idMatch ? idMatch[1]! : path;
    const rows = tables[table];
    if (!rows) return { ok: false, status: 404, text: async () => '{"message":"no such command"}' };

    if (init.method === 'GET') {
      const filters = [...u.searchParams.entries()];
      return ok(rows.filter((r) => filters.every(([k, v]) => r[k] === v)));
    }
    if (init.method === 'PUT') {
      const row = { '.id': `*${nextId++}`, ...JSON.parse(init.body!) };
      rows.push(row);
      return ok(row);
    }
    const idx = rows.findIndex((r) => r['.id'] === idMatch?.[2]);
    if (idx < 0) return { ok: false, status: 404, text: async () => '{"message":"no such item"}' };
    if (init.method === 'PATCH') {
      Object.assign(rows[idx]!, JSON.parse(init.body!));
      return ok(rows[idx]);
    }
    rows.splice(idx, 1);
    return { ok: true, status: 204, text: async () => '' };
  };

  return { tables, log, fetchImpl };
}

const make = (router: ReturnType<typeof fakeRouter>, password = 'secret') =>
  new MikrotikNetworkService({
    url: 'https://10.8.0.2/',
    user: 'api',
    password,
    hotspotServer: 'hotspot1',
    insecureTls: false,
    fetchImpl: router.fetchImpl,
  });

describe('MikrotikNetworkService', () => {
  it('creates a profile and hotspot user, and is idempotent on re-grant', async () => {
    const router = fakeRouter();
    const svc = make(router);
    const input = { username: 'ABCD2345', password: 'ABCD2345', durationMinutes: 90, rateLimit: '5M/5M', dataCapMb: 500 };

    await svc.grantAccess(input);
    await svc.grantAccess(input);

    expect(router.tables['/ip/hotspot/user/profile']).toHaveLength(1);
    expect(router.tables['/ip/hotspot/user/profile']![0]).toMatchObject({ name: 'yw-5M-5M', 'rate-limit': '5M/5M', 'shared-users': '1' });
    expect(router.tables['/ip/hotspot/user']).toHaveLength(1);
    expect(router.tables['/ip/hotspot/user']![0]).toMatchObject({
      server: 'hotspot1',
      name: 'ABCD2345',
      profile: 'yw-5M-5M',
      'limit-uptime': '1h30m',
      'limit-bytes-total': String(500 * 1024 * 1024),
    });
  });

  it('revokes by kicking active sessions, deleting cookies and removing the user', async () => {
    const router = fakeRouter();
    const svc = make(router);
    await svc.grantAccess({ username: 'ZZZZ9999', password: 'ZZZZ9999', durationMinutes: 60, rateLimit: null, dataCapMb: null });
    router.tables['/ip/hotspot/active']!.push({ '.id': '*A1', user: 'ZZZZ9999', address: '10.5.50.10' });
    router.tables['/ip/hotspot/cookie']!.push({ '.id': '*C1', user: 'ZZZZ9999' });

    await svc.revokeAccess('ZZZZ9999');
    expect(router.tables['/ip/hotspot/active']).toHaveLength(0);
    expect(router.tables['/ip/hotspot/cookie']).toHaveLength(0);
    expect(router.tables['/ip/hotspot/user']).toHaveLength(0);

    // Revoking something already gone is a no-op, not an error.
    await expect(svc.revokeAccess('ZZZZ9999')).resolves.toBeUndefined();
  });

  it('reports health and surfaces auth failures', async () => {
    const router = fakeRouter();
    expect(await make(router).healthCheck()).toEqual({ ok: true, identity: 'YW-Router' });
    const bad = await make(router, 'wrong').healthCheck();
    expect(bad.ok).toBe(false);
    expect(bad.detail).toContain('401');
  });

  it('formats RouterOS durations', () => {
    expect(toRouterOsDuration(60)).toBe('1h');
    expect(toRouterOsDuration(90)).toBe('1h30m');
    expect(toRouterOsDuration(1440)).toBe('1d');
    expect(toRouterOsDuration(10080)).toBe('7d');
  });
});

describe('MikrotikNetworkService.getUsage', () => {
  it('adds live session counters to the saved user totals', async () => {
    const router = fakeRouter();
    const svc = make(router);
    // Saved totals from earlier sessions (RouterOS updates these at logout) ...
    router.tables['/ip/hotspot/user']!.push({ '.id': '*1', name: 'AAAA2222', 'bytes-in': '1000', 'bytes-out': '9000' });
    router.tables['/ip/hotspot/user']!.push({ '.id': '*2', name: 'BBBB3333', 'bytes-in': '0', 'bytes-out': '0' });
    // ... plus the session that's connected right now.
    router.tables['/ip/hotspot/active']!.push({ '.id': '*A', user: 'AAAA2222', 'bytes-in': '500', 'bytes-out': '4500' });

    const usage = await svc.getUsage();
    expect(usage.get('AAAA2222')).toBe(15_000);
    expect(usage.get('BBBB3333')).toBe(0);
    expect(usage.has('NOPE')).toBe(false);
  });
});
