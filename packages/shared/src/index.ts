// Types and helpers shared by the API, the customer portal and the admin dashboard.
// Money is always integer kobo (₦1 = 100 kobo).

export type OrderStatus = 'pending' | 'success' | 'failed' | 'flagged';
export type SessionStatus = 'pending' | 'active' | 'expired' | 'exhausted' | 'revoked';
export type DeviceStatus = 'unknown' | 'online' | 'offline';

export interface PublicPlan {
  id: string;
  name: string;
  description: string;
  priceKobo: number;
  durationMinutes: number;
  rateLimit: string | null;
  dataCapMb: number | null;
}

export interface Plan extends PublicPlan {
  active: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

/** The buyer comes from the signed-in customer account. */
export interface CreateOrderRequest {
  planId: string;
  deviceMac?: string;
  deviceIp?: string;
}

export interface CustomerProfile {
  id: string;
  phone: string;
  name: string | null;
  email: string | null;
}

export interface RegisterRequest {
  phone: string;
  password: string;
  name?: string;
  email: string;
}

export interface LoginRequest {
  phone: string;
  password: string;
}

export interface ResetPasswordRequest {
  /** From the emailed link. */
  token: string;
  password: string;
}

export interface CreateOrderResponse {
  reference: string;
  authorizationUrl: string;
}

export interface SessionView {
  voucherCode: string;
  status: SessionStatus;
  planName: string;
  startsAt: string | null;
  expiresAt: string | null;
  durationMinutes: number;
  /** Null means unlimited data (a time pass). */
  dataCapMb: number | null;
  bytesUsed: number;
  usageUpdatedAt: string | null;
}

export interface AccountSession extends SessionView {
  id: string;
  orderReference: string;
  amountKobo: number;
  createdAt: string;
}

export interface OrderStatusResponse {
  reference: string;
  status: OrderStatus;
  amountKobo: number;
  planName: string;
  session: SessionView | null;
}

export interface AdminStats {
  revenueKobo: { today: number; last7Days: number; last30Days: number };
  orders: { pending: number; success: number; failed: number; flagged: number };
  activeSessions: number;
  pendingProvisioning: number;
  dailyRevenue: { date: string; revenueKobo: number; orders: number }[];
}

export interface AdminOrder {
  id: string;
  reference: string;
  status: OrderStatus;
  amountKobo: number;
  phone: string;
  email: string;
  planName: string;
  deviceMac: string | null;
  failureReason: string | null;
  paidAt: string | null;
  createdAt: string;
}

export interface AdminSession {
  id: string;
  voucherCode: string;
  status: SessionStatus;
  phone: string;
  planName: string;
  orderReference: string;
  startsAt: string | null;
  expiresAt: string | null;
  dataCapMb: number | null;
  bytesUsed: number;
  provisionAttempts: number;
  lastError: string | null;
  createdAt: string;
}

export interface AdminCustomer {
  id: string;
  phone: string;
  name: string | null;
  email: string | null;
  hasPassword: boolean;
  orders: number;
  spentKobo: number;
  activeSessions: number;
  createdAt: string;
}

export interface NetworkDeviceView {
  id: string;
  name: string;
  driver: string;
  status: DeviceStatus;
  identity: string | null;
  lastSeenAt: string | null;
  lastError: string | null;
}

export interface ActiveConnection {
  user: string;
  address: string | null;
  macAddress: string | null;
  uptime: string | null;
  bytesIn: number | null;
  bytesOut: number | null;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export function formatNaira(kobo: number): string {
  const naira = kobo / 100;
  return '₦' + naira.toLocaleString('en-NG', {
    minimumFractionDigits: Number.isInteger(naira) ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

export function formatDuration(minutes: number): string {
  if (minutes % (60 * 24 * 7) === 0) return plural(minutes / (60 * 24 * 7), 'week');
  if (minutes % (60 * 24) === 0) return plural(minutes / (60 * 24), 'day');
  if (minutes % 60 === 0) return plural(minutes / 60, 'hour');
  return plural(minutes, 'minute');
}

const MB = 1024 * 1024;

/** 1536 MB → "1.5 GB", 500 MB → "500 MB". Binary units, matching how the router counts. */
export function formatDataMb(mb: number): string {
  if (mb >= 1024) return `${+(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)} GB`;
  return `${Math.round(mb)} MB`;
}

export function formatBytes(bytes: number): string {
  return formatDataMb(bytes / MB);
}

/** Bytes left on a bundle, or null for unlimited plans. Never negative. */
export function bytesRemaining(s: Pick<SessionView, 'dataCapMb' | 'bytesUsed'>): number | null {
  if (s.dataCapMb === null) return null;
  return Math.max(0, s.dataCapMb * MB - s.bytesUsed);
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}
