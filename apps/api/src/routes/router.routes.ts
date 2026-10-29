import { createHash, timingSafeEqual } from 'node:crypto';
import { and, eq, isNull, lte } from 'drizzle-orm';
import express, { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { voucherBatches, vouchers } from '../db/schema';
import type { Deps } from '../deps';
import { HttpError, notFound } from '../lib/errors';
import { toExpiredScript, toRouterOsScript } from '../vouchers/export';
import { parseUsageReport, recordUsage } from '../vouchers/usage';
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

  // Each code's used time and data, sent by the router every 15 minutes in parts of a few dozen
  // lines (format in vouchers/usage.ts). A report with no lines still records that the router checked in.
  r.post('/usage', express.text({ type: '*/*', limit: '64kb' }), async (req, res) => {
    const body = typeof req.body === 'string' ? req.body : '';
    await recordUsage(deps.db, parseUsageReport(body), deps.now());
    res.sendStatus(204);
  });

  // Codes past their expiry that are still on the router, as a script that removes them. Its last
  // line confirms, marking only codes that had expired when the script was made.
  r.get('/expired.rsc', async (req, res) => {
    const now = deps.now();
    const rows = await deps.db
      .select({ code: vouchers.code })
      .from(vouchers)
      .where(and(lte(vouchers.expiresAt, now), isNull(vouchers.removedAt)));
    res.type('text/plain');
    if (!rows.length) {
      res.send(':log info "yourwifi: no expired voucher codes"\n');
      return;
    }
    const ackUrl = `${req.protocol}://${req.get('host')}/api/router/expired/ack?before=${encodeURIComponent(now.toISOString())}`;
    res.send(toExpiredScript(rows.map((r) => r.code), { ackUrl, token: deps.config.ROUTER_TOKEN! }));
  });

  r.post('/expired/ack', async (req, res) => {
    const before = z.iso.datetime().safeParse(req.query.before).data;
    if (!before) throw new HttpError(400, 'Invalid time', 'validation_error');
    await deps.db
      .update(vouchers)
      .set({ removedAt: deps.now() })
      .where(and(lte(vouchers.expiresAt, new Date(before)), isNull(vouchers.removedAt)));
    res.sendStatus(204);
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
