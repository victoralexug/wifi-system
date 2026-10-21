import type { Deps } from './deps';
import type { OrderService } from './orders/orders.service';
import type { VoucherService } from './vouchers/vouchers.service';

/** Background loops. Each tick is guarded so a slow run never overlaps the next. */
export function startJobs(deps: Deps, orders: OrderService, vouchers: VoucherService) {
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

  // Monthly voucher batch. Checked hourly, so a server that was asleep on the day catches up.
  every('voucher-generation', 3600, () => vouchers.generateScheduled());

  // Catches payments whose webhook never arrived, and paid orders still waiting for a voucher.
  every('reconcile', config.RECONCILE_INTERVAL_SECONDS, async () => {
    await orders.reconcilePending();
    await vouchers.assignWaiting();
  });

  return () => timers.forEach(clearInterval);
}
