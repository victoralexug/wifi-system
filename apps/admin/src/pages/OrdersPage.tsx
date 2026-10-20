import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { formatNaira } from '@yourwifi/shared';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { api, fmtTime } from '../api';
import { Filters, Pager, StatusBadge, useDebounced } from '../components/ui';

export function OrdersPage() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState('');
  const status = params.get('status') ?? '';
  const page = Number(params.get('page') ?? 1);
  const dq = useDebounced(q);

  const set = (patch: Record<string, string>) => setParams({ status, page: String(page), ...patch });
  const data = useQuery({
    queryKey: ['orders', page, status, dq],
    queryFn: () => api.orders({ page, status: status || undefined, q: dq || undefined }),
    placeholderData: keepPreviousData,
    refetchInterval: 15_000,
  });

  return (
    <div className="stack">
      <h1>Payments</h1>
      <Filters
        statuses={['success', 'pending', 'failed', 'flagged']}
        status={status}
        onStatus={(s) => set({ status: s, page: '1' })}
        q={q}
        onQ={(v) => {
          setQ(v);
          if (page !== 1) set({ page: '1' });
        }}
        placeholder="Search reference or phone"
      />
      {data.error && <p className="error">{data.error.message}</p>}
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Created</th>
              <th>Reference</th>
              <th>Phone</th>
              <th>Plan</th>
              <th className="num">Amount</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {data.data?.items.map((o) => (
              <tr key={o.id}>
                <td>{fmtTime(o.createdAt)}</td>
                <td className="mono">{o.reference}</td>
                <td>{o.phone}</td>
                <td>{o.planName}</td>
                <td className="num">{formatNaira(o.amountKobo)}</td>
                <td>
                  <StatusBadge status={o.status} />
                  {o.failureReason && <div className="muted small">{o.failureReason}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data.data && <Pager {...data.data} onPage={(p) => set({ page: String(p) })} />}
    </div>
  );
}
