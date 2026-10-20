import { createApp } from './app';
import { loadConfig } from './config';
import { createDatabase } from './db/client';
import { startJobs } from './jobs';
import { createLogger } from './lib/logger';
import { createNetworkService } from './network';
import { createPaymentProvider } from './payments';

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL, !config.isProd);

  const database = await createDatabase({ databaseUrl: config.DATABASE_URL, pgliteDir: config.PGLITE_DIR });
  await database.migrate(config.MIGRATIONS_DIR);
  logger.info({ driver: database.driver }, 'database ready');

  const deps = {
    config,
    db: database.db,
    logger,
    payments: createPaymentProvider(config),
    network: createNetworkService(config),
    now: () => new Date(),
  };
  const { app, sessions, orders } = createApp(deps);
  const stopJobs = startJobs(deps, sessions, orders);

  const server = app.listen(config.PORT, () => {
    logger.info(
      { port: config.PORT, payments: deps.payments.name, network: deps.network.driver },
      'YourWiFi API listening',
    );
    if (deps.payments.name === 'mock' || deps.network.driver === 'mock') {
      logger.warn('running with simulated payments and/or network; never use this setup for real customers');
    }
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    stopJobs();
    server.close();
    await database.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
