import type { Config } from './config';
import type { Database } from './db/client';
import type { Logger } from './lib/logger';
import type { NetworkService } from './network';
import type { PaymentProvider } from './payments';

export interface Deps {
  config: Config;
  db: Database;
  logger: Logger;
  payments: PaymentProvider;
  network: NetworkService;
  now: () => Date;
}
