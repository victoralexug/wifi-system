import { Router } from 'express';
import { z } from 'zod';
import type { Deps } from '../deps';
import { notFound } from '../lib/errors';
import type { OrderService } from '../orders/orders.service';
import { MockPaymentProvider } from '../payments/mock';

const body = z.object({ outcome: z.enum(['success', 'failed']) });

/** Mounted only when PAYMENT_DRIVER=mock, which the config forbids in production. */
export function devRoutes(deps: Deps, orderService: OrderService): Router {
  const r = Router();
  const provider = deps.payments;
  if (!(provider instanceof MockPaymentProvider)) return r;

  r.post('/mock-pay/:reference', async (req, res) => {
    const { outcome } = body.parse(req.body);
    if (!provider.settle(req.params.reference, outcome)) throw notFound('Unknown mock payment');
    await orderService.confirmPayment(req.params.reference);
    res.json(await orderService.getStatus(req.params.reference));
  });

  return r;
}
