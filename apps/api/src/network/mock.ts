import type { ActiveConnection } from '@yourwifi/shared';
import type { GrantAccessInput, NetworkService } from './networkService';

/**
 * In-memory controller for development and tests. The config refuses this driver in production.
 * `failNext` lets tests simulate an unreachable router.
 */
export class MockNetworkService implements NetworkService {
  readonly driver = 'mock' as const;
  readonly users = new Map<string, GrantAccessInput>();
  readonly calls: { op: 'grant' | 'revoke'; username: string }[] = [];
  /** Bytes used per username. Tests set this to simulate traffic. */
  readonly usage = new Map<string, number>();
  failNext = 0;

  async grantAccess(input: GrantAccessInput) {
    this.maybeFail();
    this.calls.push({ op: 'grant', username: input.username });
    this.users.set(input.username, input);
    return { controllerRef: `mock:${input.username}` };
  }

  async revokeAccess(username: string) {
    this.maybeFail();
    this.calls.push({ op: 'revoke', username });
    this.users.delete(username);
  }

  async listActive(): Promise<ActiveConnection[]> {
    return [...this.users.keys()].map((user) => ({
      user,
      address: null,
      macAddress: null,
      uptime: null,
      bytesIn: null,
      bytesOut: null,
    }));
  }

  async getUsage() {
    this.maybeFail();
    const out = new Map<string, number>();
    for (const name of this.users.keys()) out.set(name, this.usage.get(name) ?? 0);
    return out;
  }

  async healthCheck() {
    return { ok: true, identity: 'mock-controller' };
  }

  private maybeFail() {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('mock controller unreachable');
    }
  }
}
