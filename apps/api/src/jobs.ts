import type { Deps } from './deps';
import { pruneRateLimits } from './lib/rate-limit-store';
import type { OrderService } from './orders/orders.service';
import type { VoucherService } from './vouchers/vouchers.service';

/** The background jobs, with how often each runs on a long-lived server (in seconds). */
function jobs(deps: Deps, orders: OrderService, vouchers: VoucherService) {
  return [
    // Monthly voucher batch. Checked hourly, so a server that was asleep on the day catches up.
    { name: 'voucher-generation', seconds: 3600, run: () => vouchers.generateScheduled() },
    // Catches payments whose webhook never arrived, and paid orders still waiting for a voucher.
    {
      name: 'reconcile',
      seconds: deps.config.RECONCILE_INTERVAL_SECONDS,
      run: async () => {
        await orders.reconcilePending();
        await vouchers.assignWaiting();
      },
    },
    { name: 'rate-limit-cleanup', seconds: 3600, run: () => pruneRateLimits(deps.db) },
  ];
}

/** Runs every job once, in order. Used by the scheduled Netlify function. */
export async function runJobsOnce(deps: Deps, orders: OrderService, vouchers: VoucherService) {
  for (const job of jobs(deps, orders, vouchers)) {
    try {
      await job.run();
    } catch (err) {
      deps.logger.error({ err, job: job.name }, 'job failed');
    }
  }
}

/** Background loops for a long-lived server. Each tick is guarded so a slow run never overlaps the next. */
export function startJobs(deps: Deps, orders: OrderService, vouchers: VoucherService) {
  const { logger } = deps;
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

  for (const job of jobs(deps, orders, vouchers)) every(job.name, job.seconds, job.run);

  return () => timers.forEach(clearInterval);
}
