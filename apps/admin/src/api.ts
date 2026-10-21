import type {
  AddVouchersResult,
  AdminCustomer,
  AdminOrder,
  AdminStats,
  AdminVoucher,
  Paginated,
  Plan,
  VoucherBatchView,
  VoucherStock,
} from '@yourwifi/shared';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/admin${path}`, {
    method,
    credentials: 'include',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const issues = json?.error?.issues as { path: string[]; message: string }[] | undefined;
    const detail = issues?.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ApiError(res.status, detail || json?.error?.message || `Request failed (${res.status})`);
  }
  return json as T;
}

export interface ListParams {
  page: number;
  status?: string;
  q?: string;
  planId?: string;
}

const qs = (p: ListParams) => {
  const s = new URLSearchParams({ page: String(p.page) });
  if (p.status) s.set('status', p.status);
  if (p.q) s.set('q', p.q);
  if (p.planId) s.set('planId', p.planId);
  return `?${s}`;
};

export type PlanInput = Pick<
  Plan,
  'name' | 'description' | 'priceKobo' | 'durationMinutes' | 'dataCapMb' | 'active' | 'sortOrder' | 'voucherStockTarget'
>;

export const api = {
  me: () => call<{ email: string }>('GET', '/me'),
  login: (email: string, password: string) => call<{ email: string }>('POST', '/login', { email, password }),
  logout: () => call<void>('POST', '/logout'),
  stats: () => call<AdminStats>('GET', '/stats'),
  orders: (p: ListParams) => call<Paginated<AdminOrder>>('GET', `/orders${qs(p)}`),
  customers: (p: ListParams) => call<Paginated<AdminCustomer>>('GET', `/customers${qs(p)}`),
  resetCustomerPassword: (id: string) => call<{ temporaryPassword: string }>('POST', `/customers/${id}/reset-password`),
  plans: () => call<Plan[]>('GET', '/plans'),
  createPlan: (p: PlanInput) => call<Plan>('POST', '/plans', p),
  updatePlan: (id: string, p: Partial<PlanInput>) => call<Plan>('PATCH', `/plans/${id}`, p),
  voucherStock: () => call<VoucherStock[]>('GET', '/vouchers/stock'),
  vouchers: (p: ListParams) => call<Paginated<AdminVoucher>>('GET', `/vouchers${qs(p)}`),
  addVouchers: (planId: string, codes: string) => call<AddVouchersResult>('POST', '/vouchers', { planId, codes }),
  deleteVoucher: (id: string) => call<void>('DELETE', `/vouchers/${id}`),
  voucherBatches: () => call<VoucherBatchView[]>('GET', '/vouchers/batches'),
  generateBatch: () => call<{ batch: { id: string; codeCount: number } | null }>('POST', '/vouchers/batches'),
  markBatchReady: (id: string) => call<void>('POST', `/vouchers/batches/${id}/ready`),
  batchExportUrl: (id: string, format: 'rsc' | 'csv') => `/api/admin/vouchers/batches/${id}/export?format=${format}`,
};

const lagos = new Intl.DateTimeFormat('en-NG', {
  timeZone: 'Africa/Lagos',
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
});
export const fmtTime = (iso: string | null) => (iso ? lagos.format(new Date(iso)) : '—');
