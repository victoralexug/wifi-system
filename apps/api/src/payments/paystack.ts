import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  InitializePaymentInput,
  ParsedWebhook,
  PaymentProvider,
  VerifiedPayment,
} from './provider';

type FetchLike = typeof fetch;

interface PaystackEnvelope<T> {
  status: boolean;
  message: string;
  data: T;
}

export class PaystackProvider implements PaymentProvider {
  readonly name = 'paystack' as const;

  constructor(
    private readonly secretKey: string,
    private readonly baseUrl = 'https://api.paystack.co',
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async initialize(input: InitializePaymentInput) {
    const data = await this.request<{ authorization_url: string; reference: string }>(
      'POST',
      '/transaction/initialize',
      {
        email: input.email,
        amount: input.amountKobo,
        currency: 'NGN',
        reference: input.reference,
        callback_url: input.callbackUrl,
        metadata: input.metadata,
      },
    );
    return { authorizationUrl: data.authorization_url };
  }

  async verify(reference: string): Promise<VerifiedPayment> {
    const data = await this.request<{
      status: string;
      reference: string;
      amount: number;
      currency: string;
      paid_at: string | null;
    }>('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
    return {
      reference: data.reference,
      status: mapStatus(data.status),
      amountKobo: data.amount,
      currency: data.currency,
      paidAt: data.paid_at ? new Date(data.paid_at) : null,
      raw: data,
    };
  }

  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): ParsedWebhook | null {
    const signature = headers['x-paystack-signature'];
    if (typeof signature !== 'string' || !this.isValidSignature(rawBody, signature)) return null;
    let payload: { event?: string; data?: { reference?: string } };
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return null;
    }
    return {
      event: payload.event ?? 'unknown',
      reference: payload.data?.reference ?? null,
      payload,
    };
  }

  /** Paystack signs the raw body with HMAC-SHA512 using the secret key. */
  isValidSignature(rawBody: Buffer, signature: string): boolean {
    const expected = createHmac('sha512', this.secretKey).update(rawBody).digest('hex');
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(signature, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => null)) as PaystackEnvelope<T> | null;
    if (!res.ok || !json?.status) {
      throw new Error(`Paystack ${method} ${path} failed (${res.status}): ${json?.message ?? 'no body'}`);
    }
    return json.data;
  }
}

function mapStatus(status: string): VerifiedPayment['status'] {
  switch (status) {
    case 'success':
      return 'success';
    case 'failed':
    case 'reversed':
      return 'failed';
    case 'abandoned':
      return 'abandoned';
    default:
      // ongoing, pending, processing, queued
      return 'pending';
  }
}
