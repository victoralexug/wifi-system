export interface InitializePaymentInput {
  reference: string;
  amountKobo: number;
  email: string;
  callbackUrl: string;
  metadata?: Record<string, unknown>;
}

export interface VerifiedPayment {
  reference: string;
  // 'success' is the only status that may ever grant access.
  status: 'success' | 'failed' | 'abandoned' | 'pending';
  amountKobo: number;
  currency: string;
  paidAt: Date | null;
  raw: unknown;
}

export interface ParsedWebhook {
  event: string;
  reference: string | null;
  payload: unknown;
}

export interface PaymentProvider {
  readonly name: 'paystack' | 'mock';
  initialize(input: InitializePaymentInput): Promise<{ authorizationUrl: string }>;
  /** Server-to-server lookup of the payment's true state. */
  verify(reference: string): Promise<VerifiedPayment>;
  /** Returns null when the signature is missing or invalid. */
  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): ParsedWebhook | null;
}
