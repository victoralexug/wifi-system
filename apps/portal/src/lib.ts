import type {
  AccountOrder,
  CreateOrderRequest,
  CreateOrderResponse,
  CustomerProfile,
  LoginRequest,
  OrderStatusResponse,
  PublicPlan,
  RegisterRequest,
  ResetPasswordRequest,
} from '@yourwifi/shared';

export const BRAND = import.meta.env.VITE_BRAND_NAME || 'YourWiFi';
export const SUPPORT_PHONE = import.meta.env.VITE_SUPPORT_PHONE || '';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /** The API's error code, e.g. 'account_exists' or 'email_taken'. */
    public readonly code?: string,
  ) {
    super(message);
  }
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  // credentials: same-origin is the default; the customer session is an httpOnly cookie.
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'Network problem. Check your connection and try again.');
  }
  if (res.status === 204) return undefined as T;
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const issue = json?.error?.issues?.[0]?.message as string | undefined;
    throw new ApiError(res.status, issue ?? json?.error?.message ?? 'Something went wrong. Please try again.', json?.error?.code);
  }
  return json as T;
}

export const api = {
  plans: () => call<PublicPlan[]>('GET', '/plans'),
  createOrder: (body: CreateOrderRequest) => call<CreateOrderResponse>('POST', '/orders', body),
  order: (reference: string) => call<OrderStatusResponse>('GET', `/orders/${encodeURIComponent(reference)}`),
  verify: (reference: string) => call<OrderStatusResponse>('POST', `/orders/${encodeURIComponent(reference)}/verify`),
  register: (body: RegisterRequest) => call<CustomerProfile>('POST', '/auth/register', body),
  login: (body: LoginRequest) => call<CustomerProfile>('POST', '/auth/login', body),
  logout: () => call<void>('POST', '/auth/logout'),
  forgotPassword: (email: string) => call<void>('POST', '/auth/forgot-password', { email }),
  resetPassword: (body: ResetPasswordRequest) => call<CustomerProfile>('POST', '/auth/reset-password', body),
  me: () => call<CustomerProfile>('GET', '/me'),
  myOrders: () => call<AccountOrder[]>('GET', '/me/orders'),
  changePassword: (currentPassword: string, newPassword: string) =>
    call<void>('POST', '/me/password', { currentPassword, newPassword }),
  changeEmail: (email: string, currentPassword: string) =>
    call<CustomerProfile>('POST', '/me/email', { email, currentPassword }),
  mockPay: (reference: string, outcome: 'success' | 'failed') =>
    call<OrderStatusResponse>('POST', `/dev/mock-pay/${encodeURIComponent(reference)}`, { outcome }),
};

// Storage can be unavailable in captive-portal mini-browsers, so every access is guarded.
export const store = {
  get(key: string, kind: 'local' | 'session' = 'local'): string | null {
    try {
      return (kind === 'local' ? localStorage : sessionStorage).getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string, kind: 'local' | 'session' = 'local') {
    try {
      (kind === 'local' ? localStorage : sessionStorage).setItem(key, value);
    } catch {
      // ignore
    }
  },
};

const lagos = new Intl.DateTimeFormat('en-NG', {
  timeZone: 'Africa/Lagos',
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
});

export const formatLagosTime = (iso: string) => lagos.format(new Date(iso));


/** Sends the customer to sign in, then back to `next` afterwards. */
export function signInUrl(next: string = location.pathname + location.search) {
  return `/signin?next=${encodeURIComponent(next)}`;
}

/** Only same-site paths are allowed as a post-sign-in destination. */
export function safeNext(raw: string | null): string {
  return raw && raw.startsWith('/') && !raw.startsWith('//') ? raw : '/account';
}

export function navigate(path: string) {
  history.pushState(null, '', path);
  dispatchEvent(new PopStateEvent('popstate'));
}
