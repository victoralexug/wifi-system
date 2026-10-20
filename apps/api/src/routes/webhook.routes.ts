import express, { Router } from 'express';
import { webhookEvents } from '../db/schema';
import type { Deps } from '../deps';
import type { OrderService } from '../orders/orders.service';

/**
 * Must be mounted before express.json(): the signature is computed over the raw bytes.
 * The webhook only triggers confirmPayment, which re-verifies with Paystack before granting
 * anything, so a replayed or forged event can never grant access by itself.
 */
export function webhookRoutes(deps: Deps, orderService: OrderService): Router {
  const r = Router();

  r.post('/paystack', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const parsed = deps.payments.parseWebhook(raw, req.headers);

    await deps.db.insert(webhookEvents).values({
      provider: 'paystack',
      event: parsed?.event ?? null,
      reference: parsed?.reference ?? null,
      signatureValid: parsed !== null,
      payload: parsed?.payload ?? null,
    });

    if (!parsed) {
      deps.logger.warn('rejected paystack webhook with invalid signature');
      res.sendStatus(401);
      return;
    }

    if (parsed.event === 'charge.success' && parsed.reference) {
      // Provisioning runs in the background so Paystack gets a quick 200.
      // The retry job handles routers that are slow or offline.
      await orderService.confirmPayment(parsed.reference, { awaitProvision: false });
    }
    res.sendStatus(200);
  });

  return r;
}
