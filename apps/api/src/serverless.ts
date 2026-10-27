import { createApp, type App } from './app';
import { loadConfig } from './config';
import { createDatabase } from './db/client';
import type { Deps } from './deps';
import { createLogger } from './lib/logger';
import { createMailService } from './mail';
import { createPaymentProvider } from './payments';

/**
 * The API for Netlify Functions (src/functions/). Built once per function instance and reused
 * across requests. Migrations run in the Netlify build, not here.
 */
let ready: Promise<App & { deps: Deps }> | undefined;

export function serverlessApp() {
  ready ??= build().catch((err) => {
    ready = undefined; // try again on the next request
    throw err;
  });
  return ready;
}

async function build() {
  const config = loadConfig();
  if (!config.DATABASE_URL) throw new Error('DATABASE_URL is required on Netlify');
  const logger = createLogger(config.LOG_LEVEL, false);
  const database = await createDatabase({ databaseUrl: config.DATABASE_URL, poolMax: 3 });
  const deps: Deps = {
    config,
    db: database.db,
    logger,
    payments: createPaymentProvider(config),
    mail: createMailService(config, logger),
    now: () => new Date(),
  };
  return { ...createApp(deps), deps };
}
