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
import { devRoutes } from './routes/dev.routes';
import { publicRoutes } from './routes/public.routes';
import { webhookRoutes } from './routes/webhook.routes';
import { SessionService } from './sessions/sessions.service';

export interface App {
  app: Express;
  sessions: SessionService;
  orders: OrderService;
}

export function createApp(deps: Deps): App {
  const { config, logger } = deps;
  const sessions = new SessionService(deps);
  const orders = new OrderService(deps, sessions);
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
          // The portal's "connect" step posts a form to the router's hotspot login page.
          'form-action': ["'self'", 'http:', 'https:'],
        },
      },
    }),
  );
  app.use('/api', cors({ origin: config.CORS_ORIGINS, credentials: true }));

  // Raw body for signature checks: must come before express.json().
  app.use('/api/webhooks', webhookRoutes(deps, orders));

  app.use(express.json({ limit: '32kb' }));
  app.use(cookieParser());
  const customers = customerAuth(config.ADMIN_JWT_SECRET, config.isProd);
  app.use('/api', customerRoutes(deps, customers));
  app.use('/api', publicRoutes(deps, orders, customers.require));
  app.use('/api/admin', adminRoutes(deps, sessions));
  if (deps.payments.name === 'mock') app.use('/api/dev', devRoutes(deps, orders, sessions));
  app.use('/api', notFoundHandler);

  if (config.SERVE_STATIC) mountStatic(app);

  app.use(errorHandler(logger));
  return { app, sessions, orders };
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
