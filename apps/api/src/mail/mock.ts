import type { Logger } from '../lib/logger';
import type { MailMessage, MailService } from './mailService';

/**
 * Logs emails instead of sending them, so reset links can be copied from the API console in dev.
 * The config refuses this driver in production. Tests read `sent`.
 */
export class MockMailService implements MailService {
  readonly driver = 'mock' as const;
  readonly sent: MailMessage[] = [];

  constructor(private readonly logger?: Logger) {}

  async send(message: MailMessage) {
    this.sent.push(message);
    this.logger?.info({ to: message.to, subject: message.subject, text: message.text }, 'mock email (not sent)');
  }
}
