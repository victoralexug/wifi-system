import nodemailer, { type Transporter } from 'nodemailer';
import type { MailMessage, MailService } from './mailService';

export class SmtpMailService implements MailService {
  readonly driver = 'smtp' as const;
  private readonly transport: Transporter;

  constructor(
    smtpUrl: string,
    private readonly from: string,
  ) {
    this.transport = nodemailer.createTransport(smtpUrl);
  }

  async send(message: MailMessage) {
    await this.transport.sendMail({ from: this.from, ...message });
  }
}
