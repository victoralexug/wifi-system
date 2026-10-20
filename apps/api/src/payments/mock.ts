import type { InitializePaymentInput, PaymentProvider, VerifiedPayment } from './provider';

/**
 * Development stand-in for Paystack. Checkout goes to the portal's /mock-pay page, which
 * calls the dev-only /api/dev/mock-pay endpoint to settle the payment.
 * The config refuses to start with this driver in production.
 */
export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock' as const;
  private readonly payments = new Map<string, { amountKobo: number; status: VerifiedPayment['status']; paidAt: Date | null }>();

  constructor(private readonly portalUrl: string) {}

  async initialize(input: InitializePaymentInput) {
    this.payments.set(input.reference, { amountKobo: input.amountKobo, status: 'pending', paidAt: null });
    const url = new URL('/mock-pay', this.portalUrl);
    url.searchParams.set('reference', input.reference);
    url.searchParams.set('amount', String(input.amountKobo));
    return { authorizationUrl: url.toString() };
  }

  async verify(reference: string): Promise<VerifiedPayment> {
    const p = this.payments.get(reference);
    return {
      reference,
      status: p?.status ?? 'pending',
      amountKobo: p?.amountKobo ?? 0,
      currency: 'NGN',
      paidAt: p?.paidAt ?? null,
      raw: { mock: true },
    };
  }

  parseWebhook() {
    return null;
  }

  /** Simulates the customer completing (or failing) checkout. */
  settle(reference: string, outcome: 'success' | 'failed', amountKobo?: number) {
    const p = this.payments.get(reference);
    if (!p) return false;
    p.status = outcome;
    p.paidAt = outcome === 'success' ? new Date() : null;
    if (amountKobo !== undefined) p.amountKobo = amountKobo;
    return true;
  }
}
