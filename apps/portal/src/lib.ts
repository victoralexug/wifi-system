import type {
  AccountSession,
  CreateOrderRequest,
  CreateOrderResponse,
  CustomerProfile,
  LoginRequest,
  OrderStatusResponse,
  PublicPlan,
  RegisterRequest,
  SessionView,
} from '@yourwifi/shared';

export const BRAND = import.meta.env.VITE_BRAND_NAME || 'YourWiFi';
export const SUPPORT_PHONE = import.meta.env.VITE_SUPPORT_PHONE || '';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
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
    throw new ApiError(0, 'Network problem. Check that you are still connected to the Wi-Fi.');
  }
  if (res.status === 204) return undefined as T;
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const issue = json?.error?.issues?.[0]?.message as string | undefined;
    throw new ApiError(res.status, issue ?? json?.error?.message ?? 'Something went wrong. Please try again.');
  }
  return json as T;
}

export const api = {
  plans: () => call<PublicPlan[]>('GET', '/plans'),
  createOrder: (body: CreateOrderRequest) => call<CreateOrderResponse>('POST', '/orders', body),
  order: (reference: string) => call<OrderStatusResponse>('GET', `/orders/${encodeURIComponent(reference)}`),
  verify: (reference: string) => call<OrderStatusResponse>('POST', `/orders/${encodeURIComponent(reference)}/verify`),
  lookup: (code: string) => call<SessionView>('POST', '/sessions/lookup', { code }),
  register: (body: RegisterRequest) => call<CustomerProfile>('POST', '/auth/register', body),
  login: (body: LoginRequest) => call<CustomerProfile>('POST', '/auth/login', body),
  logout: () => call<void>('POST', '/auth/logout'),
  me: () => call<CustomerProfile>('GET', '/me'),
  mySessions: () => call<AccountSession[]>('GET', '/me/sessions'),
  changePassword: (currentPassword: string, newPassword: string) =>
    call<void>('POST', '/me/password', { currentPassword, newPassword }),
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

/**
 * Details the MikroTik hotspot passes in the redirect to the portal (see infra/mikrotik/hotspot/login.html).
 * They are captured on first load and kept for the tab's lifetime, so they survive the Paystack round trip.
 */
export interface HotspotContext {
  mac?: string;
  ip?: string;
  linkLoginOnly?: string;
  linkOrig?: string;
  error?: string;
}

const HOTSPOT_KEY = 'yw:hotspot';

export function captureHotspotContext(): HotspotContext {
  const q = new URLSearchParams(location.search);
  const fromUrl: HotspotContext = {
    mac: q.get('mac') || undefined,
    ip: q.get('ip') || undefined,
    linkLoginOnly: q.get('link-login-only') || undefined,
    linkOrig: q.get('link-orig') || undefined,
    error: q.get('error') || undefined,
  };
  // localStorage rather than sessionStorage: some mini-browsers open Paystack's return redirect in a new tab.
  if (fromUrl.linkLoginOnly) {
    store.set(HOTSPOT_KEY, JSON.stringify(fromUrl));
    return fromUrl;
  }
  let saved: HotspotContext = {};
  try {
    saved = JSON.parse(store.get(HOTSPOT_KEY) ?? '{}');
  } catch {
    // ignore
  }
  return fromUrl.error ? { ...saved, error: fromUrl.error } : saved;
}

const allowedHosts = (import.meta.env.VITE_HOTSPOT_LOGIN_HOSTS || '10.5.50.1,login.yourwifi')
  .split(',')
  .map((h: string) => h.trim().toLowerCase())
  .filter(Boolean);

/** Voucher credentials are only ever posted to the router itself, never to an arbitrary URL from the query string. */
export function safeLoginUrl(ctx: HotspotContext): string | null {
  if (!ctx.linkLoginOnly) return null;
  try {
    const u = new URL(ctx.linkLoginOnly);
    if (!['http:', 'https:'].includes(u.protocol)) return null;
    return allowedHosts.includes(u.hostname.toLowerCase()) ? u.toString() : null;
  } catch {
    return null;
  }
}

const lagos = new Intl.DateTimeFormat('en-NG', {
  timeZone: 'Africa/Lagos',
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
});

export const formatLagosTime = (iso: string) => lagos.format(new Date(iso));

export function formatRemaining(iso: string, now = Date.now()): string {
  const mins = Math.max(0, Math.round((new Date(iso).getTime() - now) / 60_000));
  if (mins >= 2 * 1440) return `${Math.floor(mins / 1440)} days left`;
  if (mins >= 120) return `${Math.floor(mins / 60)} hours left`;
  if (mins >= 60) return `1 hour ${mins - 60} min left`;
  return `${mins} min left`;
}

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
