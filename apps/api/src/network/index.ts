import type { Config } from '../config';
import { MikrotikNetworkService } from './mikrotik';
import { MockNetworkService } from './mock';
import type { NetworkService } from './networkService';

export type { NetworkService } from './networkService';

export function createNetworkService(config: Config): NetworkService {
  if (config.NETWORK_DRIVER === 'mikrotik') {
    return new MikrotikNetworkService({
      url: config.MIKROTIK_URL!,
      user: config.MIKROTIK_USER!,
      password: config.MIKROTIK_PASSWORD!,
      hotspotServer: config.MIKROTIK_HOTSPOT_SERVER,
      insecureTls: config.MIKROTIK_INSECURE_TLS,
    });
  }
  return new MockNetworkService();
}
