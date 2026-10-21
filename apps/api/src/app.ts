import fs from 'node:fs';
import path from 'node:path';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { adminRoutes } from './admin/admin.routes';
import { customerAuth } from './customers/customer.auth';
import { customerRoutes } from './customers/customer.routes';
import type { Deps } from './deps';
import { errorHandler, notFoundHandler } from './lib/errors';
import { OrderService } from './orders/orders.service';
import { VoucherService } from './vouchers/vouchers.service';
import { devRoutes } from './routes/dev.routes';
import { publicRoutes } from './routes/public.routes';
import { routerRoutes } from './routes/router.routes';
import { webhookRoutes } from './routes/webhook.routes';

export interface App {
  app: Express;
  orders: OrderService;
  vouchers: VoucherService;
}

export function createApp(deps: Deps): App {
  const { config, logger } = deps;
  const vouchers = new VoucherService(deps);
  const orders = new OrderService(deps, vouchers);
  const app = express();

  app.disable('x-powered-by');
  if (config.TRUST_PROXY) app.set('trust proxy', 1);
  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/api/health' } }));
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          // Paystack checkout is a full-page redirect, so no third-party scripts are needed.
          'default-src': ["'self'"],
          'img-src': ["'self'", 'data:'],
        },
      },
    }),
  );
  app.use('/api', cors({ origin: config.CORS_ORIGINS, credentials: true }));

  // Raw body for signature checks: must come before express.json().
  app.use('/api/webhooks', webhookRoutes(deps, orders));

  // Voucher uploads can hold thousands of codes; everything else stays small.
  app.use('/api/admin/vouchers', express.json({ limit: '1mb' }));
  app.use(express.json({ limit: '32kb' }));
  app.use(cookieParser());
  const customers = customerAuth(config.ADMIN_JWT_SECRET, config.isProd);
  app.use('/api', customerRoutes(deps, customers));
  app.use('/api', publicRoutes(deps, orders, vouchers, customers.require));
  app.use('/api/admin', adminRoutes(deps, vouchers));
  if (config.ROUTER_TOKEN) app.use('/api/router', routerRoutes(deps, vouchers));
  if (deps.payments.name === 'mock') app.use('/api/dev', devRoutes(deps, orders));
  app.use('/api', notFoundHandler);

  if (config.SERVE_STATIC) mountStatic(app);

  app.use(errorHandler(logger));
  return { app, orders, vouchers };
}

/** Serves the built frontends from one origin: portal at /, admin at /admin/. */
function mountStatic(app: Express) {
  const root = path.resolve(process.cwd(), '..');
  const spa = (urlPath: string, dir: string) => {
    if (!fs.existsSync(path.join(dir, 'index.html'))) return;
    app.use(urlPath, express.static(dir, { index: false, maxAge: '1h' }));
    app.get(`${urlPath === '/' ? '' : urlPath}/{*splat}`, (_req, res) => res.sendFile(path.join(dir, 'index.html')));
  };
  spa('/admin', path.join(root, 'admin', 'dist'));
  spa('/', path.join(root, 'portal', 'dist'));
}
