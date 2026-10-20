import { Router } from 'express';
import { z } from 'zod';
import type { Deps } from '../deps';
import { notFound } from '../lib/errors';
import type { OrderService } from '../orders/orders.service';
import { MockNetworkService } from '../network/mock';
import { MockPaymentProvider } from '../payments/mock';
import type { SessionService } from '../sessions/sessions.service';

const body = z.object({ outcome: z.enum(['success', 'failed']) });
const usageBody = z.object({ megabytes: z.number().min(0).max(10_000_000) });

/** Mounted only when PAYMENT_DRIVER=mock, which the config forbids in production. */
export function devRoutes(deps: Deps, orderService: OrderService, sessions: SessionService): Router {
  const r = Router();
  const provider = deps.payments;
  if (!(provider instanceof MockPaymentProvider)) return r;

  // Simulates a customer's traffic on the mock router, then syncs usage straight away.
  const network = deps.network;
  if (network instanceof MockNetworkService) {
    r.post('/mock-usage/:code', async (req, res) => {
      const { megabytes } = usageBody.parse(req.body);
      network.usage.set(String(req.params.code), Math.round(megabytes * 1024 * 1024));
      res.json(await sessions.syncUsage());
    });
  }

  r.post('/mock-pay/:reference', async (req, res) => {
    const { outcome } = body.parse(req.body);
    if (!provider.settle(req.params.reference, outcome)) throw notFound('Unknown mock payment');
    await orderService.confirmPayment(req.params.reference, { awaitProvision: true });
    res.json(await orderService.getStatus(req.params.reference));
  });

  return r;
}
