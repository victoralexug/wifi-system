import type { Config } from './config';
import type { Database } from './db/client';
import type { Logger } from './lib/logger';
import type { MailService } from './mail';
import type { PaymentProvider } from './payments';

export interface Deps {
  config: Config;
  db: Database;
  logger: Logger;
  payments: PaymentProvider;
  mail: MailService;
  now: () => Date;
}
