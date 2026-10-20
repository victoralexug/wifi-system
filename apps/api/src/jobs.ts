import { networkDevices } from './db/schema';
import type { Deps } from './deps';
import type { OrderService } from './orders/orders.service';
import type { SessionService } from './sessions/sessions.service';

export async function checkNetworkHealth(deps: Deps) {
  const result = await deps.network.healthCheck();
  const now = deps.now();
  await deps.db
    .insert(networkDevices)
    .values({
      name: deps.config.NETWORK_DEVICE_NAME,
      driver: deps.network.driver,
      status: result.ok ? 'online' : 'offline',
      identity: result.identity ?? null,
      lastSeenAt: result.ok ? now : null,
      lastError: result.ok ? null : (result.detail ?? 'unreachable'),
    })
    .onConflictDoUpdate({
      target: networkDevices.name,
      set: {
        driver: deps.network.driver,
        status: result.ok ? 'online' : 'offline',
        ...(result.ok ? { identity: result.identity ?? null, lastSeenAt: now, lastError: null } : {}),
        ...(!result.ok ? { lastError: result.detail ?? 'unreachable' } : {}),
      },
    });
  return result;
}

/** Background loops. Each tick is guarded so a slow router never causes overlapping runs. */
export function startJobs(deps: Deps, sessions: SessionService, orders: OrderService) {
  const { logger, config } = deps;
  const timers: NodeJS.Timeout[] = [];

  const every = (name: string, seconds: number, fn: () => Promise<unknown>) => {
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      try {
        await fn();
      } catch (err) {
        logger.error({ err, job: name }, 'job failed');
      } finally {
        running = false;
      }
    };
    timers.push(setInterval(tick, seconds * 1000));
    void tick();
  };

  every('sessions', config.JOB_INTERVAL_SECONDS, async () => {
    await sessions.retryPending();
    // Usage first, so a bundle that ran out is marked exhausted rather than expired.
    // A failed usage read (router offline) must not stop time-based expiry.
    await sessions.syncUsage().catch((err) => logger.warn({ err: (err as Error).message }, 'usage sync failed'));
    await sessions.expireDue();
  });
  every('reconcile', Math.max(config.JOB_INTERVAL_SECONDS * 4, 60), () => orders.reconcilePending());
  every('health', config.HEALTH_INTERVAL_SECONDS, () => checkNetworkHealth(deps));

  return () => timers.forEach(clearInterval);
}
