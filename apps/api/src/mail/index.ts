import type { Config } from '../config';
import type { Logger } from '../lib/logger';
import type { MailService } from './mailService';
import { MockMailService } from './mock';
import { SmtpMailService } from './smtp';

export type { MailMessage, MailService } from './mailService';

export function createMailService(config: Config, logger: Logger): MailService {
  if (config.MAIL_DRIVER === 'smtp') return new SmtpMailService(config.SMTP_URL!, config.MAIL_FROM);
  return new MockMailService(logger);
}
