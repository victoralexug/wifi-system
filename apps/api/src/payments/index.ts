import type { Config } from '../config';
import { MockPaymentProvider } from './mock';
import { PaystackProvider } from './paystack';
import type { PaymentProvider } from './provider';

export type { PaymentProvider } from './provider';

export function createPaymentProvider(config: Config): PaymentProvider {
  if (config.PAYMENT_DRIVER === 'paystack') {
    return new PaystackProvider(config.PAYSTACK_SECRET_KEY!, config.PAYSTACK_BASE_URL);
  }
  return new MockPaymentProvider(config.PUBLIC_PORTAL_URL);
}
