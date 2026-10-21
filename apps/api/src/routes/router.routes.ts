import { createHash, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { voucherBatches } from '../db/schema';
import type { Deps } from '../deps';
import { HttpError, notFound } from '../lib/errors';
import { toRouterOsScript } from '../vouchers/export';
import type { VoucherService } from '../vouchers/vouchers.service';

/**
 * Lets the router collect generated voucher batches on its own schedule (infra/mikrotik/). The
 * router only makes outgoing requests, so this works without a tunnel or a constant connection.
 * Mounted only when ROUTER_TOKEN is set.
 */
export function routerRoutes(deps: Deps, voucherService: VoucherService): Router {
  const r = Router();
  // Hashing both sides gives equal-length buffers, so the comparison is timing-safe.
  const expected = createHash('sha256').update(`Bearer ${deps.config.ROUTER_TOKEN}`).digest();
  const requireRouter: RequestHandler = (req, _res, next) => {
    const given = createHash('sha256').update(req.get('authorization') ?? '').digest();
    if (!timingSafeEqual(given, expected)) return next(new HttpError(401, 'Invalid router token', 'unauthenticated'));
    next();
  };
  r.use(requireRouter);

  // Every batch still waiting for the router, as one script the router imports. Its last lines
  // confirm each batch, so a failed or partial import is simply collected again next time.
  r.get('/vouchers.rsc', async (req, res) => {
    const batchIds = await voucherService.waitingBatchIds();
    const rows = await voucherService.batchCodes(batchIds);
    const base = `${req.protocol}://${req.get('host')}`;
    res.type('text/plain');
    if (!rows.length) {
      res.send(':log info "yourwifi: no new voucher codes"\n');
      return;
    }
    res.send(
      toRouterOsScript(rows, {
        generatedAt: deps.now(),
        ackUrls: batchIds.map((id) => `${base}/api/router/batches/${id}/ack`),
        token: deps.config.ROUTER_TOKEN,
      }),
    );
  });

  r.post('/batches/:id/ack', async (req, res) => {
    const id = z.uuid().safeParse(req.params.id).data;
    if (!id) throw notFound('Batch not found');
    const [batch] = await deps.db.select({ id: voucherBatches.id }).from(voucherBatches).where(eq(voucherBatches.id, id));
    if (!batch) throw notFound('Batch not found');
    // Already-ready batches are fine: the router may confirm the same batch twice.
    await voucherService.markReady(id, 'router');
    res.sendStatus(204);
  });

  return r;
}
