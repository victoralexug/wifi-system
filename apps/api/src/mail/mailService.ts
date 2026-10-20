export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** Outgoing email. Used only for password reset links. */
export interface MailService {
  readonly driver: 'mock' | 'smtp';
  send(message: MailMessage): Promise<void>;
}
