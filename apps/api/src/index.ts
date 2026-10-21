import { createApp } from './app';
import { loadConfig } from './config';
import { createDatabase } from './db/client';
import { startJobs } from './jobs';
import { createLogger } from './lib/logger';
import { createMailService } from './mail';
import { createPaymentProvider } from './payments';

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL, !config.isProd);

  const database = await createDatabase({ databaseUrl: config.DATABASE_URL, pgliteDir: config.PGLITE_DIR });
  await database.migrate(config.MIGRATIONS_DIR);
  logger.info({ driver: database.driver }, 'database ready');

  const now = () => new Date();
  const deps = {
    config,
    db: database.db,
    logger,
    payments: createPaymentProvider(config),
    mail: createMailService(config, logger),
    now,
  };
  const { app, orders, vouchers } = createApp(deps);
  const stopJobs = startJobs(deps, orders, vouchers);

  const server = app.listen(config.PORT, () => {
    logger.info(
      { port: config.PORT, payments: deps.payments.name, mail: deps.mail.driver },
      'YourWiFi API listening',
    );
    if (deps.payments.name === 'mock') {
      logger.warn('running with simulated payments; never use this setup for real customers');
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
