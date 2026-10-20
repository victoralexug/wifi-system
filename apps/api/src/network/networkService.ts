import type { ActiveConnection } from '@yourwifi/shared';

export interface GrantAccessInput {
  /** The voucher code, used as both hotspot username and password. */
  username: string;
  password: string;
  durationMinutes: number;
  /** RouterOS rate-limit syntax ("rx/tx", e.g. "5M/5M"), or null for unlimited. */
  rateLimit: string | null;
  dataCapMb: number | null;
  comment?: string;
}

export interface HealthResult {
  ok: boolean;
  identity?: string;
  detail?: string;
}

/**
 * The only way the rest of the app talks to network hardware.
 * Implementations must be idempotent: granting an existing username updates it, and
 * revoking a missing one succeeds. The background jobs rely on this when they retry.
 */
export interface NetworkService {
  readonly driver: 'mock' | 'mikrotik';
  grantAccess(input: GrantAccessInput): Promise<{ controllerRef: string }>;
  revokeAccess(username: string): Promise<void>;
  listActive(): Promise<ActiveConnection[]>;
  /**
   * Total bytes (up + down) used so far by each hotspot user the controller knows about,
   * including the live session. Users missing from the map have no record on the controller.
   */
  getUsage(): Promise<Map<string, number>>;
  healthCheck(): Promise<HealthResult>;
}
