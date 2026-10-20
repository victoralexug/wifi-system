import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { formatNaira } from '@yourwifi/shared';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { api, fmtTime } from '../api';
import { Pager, useDebounced } from '../components/ui';

export function CustomersPage() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState('');
  const page = Number(params.get('page') ?? 1);
  const dq = useDebounced(q);

  const data = useQuery({
    queryKey: ['customers', page, dq],
    queryFn: () => api.customers({ page, q: dq || undefined }),
    placeholderData: keepPreviousData,
  });

  // Reset asks for confirmation inline, then shows the one-time password once.
  const [confirming, setConfirming] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ id: string; password: string } | null>(null);
  const reset = useMutation({
    mutationFn: api.resetCustomerPassword,
    onSuccess: (r, id) => {
      setIssued({ id, password: r.temporaryPassword });
      setConfirming(null);
    },
  });

  return (
    <div className="stack">
      <div>
        <h1>Customers</h1>
        <p className="muted">
          When a customer forgets their password, reset it here and read them the temporary password over the phone.
          They can change it from their account page.
        </p>
      </div>
      <div className="filters">
        <input
          type="search"
          placeholder="Search phone, name or email"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            if (page !== 1) setParams({ page: '1' });
          }}
          aria-label="Search customers"
        />
      </div>
      {(data.error || reset.error) && <p className="error">{data.error?.message ?? reset.error?.message}</p>}
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Phone</th>
              <th>Name</th>
              <th className="num">Plans bought</th>
              <th className="num">Total spent</th>
              <th className="num">Active</th>
              <th>Joined</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.data?.items.map((c) => (
              <tr key={c.id}>
                <td>
                  {c.phone}
                  {c.email && <div className="muted small">{c.email}</div>}
                </td>
                <td>{c.name ?? '—'}</td>
                <td className="num">{c.orders}</td>
                <td className="num">{formatNaira(c.spentKobo)}</td>
                <td className="num">{c.activeSessions}</td>
                <td>{fmtTime(c.createdAt)}</td>
                <td className="actions">
                  {issued?.id === c.id ? (
                    <span className="temp-password">
                      Temporary password: <strong className="mono">{issued.password}</strong>
                      <button className="btn ghost" onClick={() => setIssued(null)}>
                        Done
                      </button>
                    </span>
                  ) : confirming === c.id ? (
                    <>
                      <button className="btn danger" disabled={reset.isPending} onClick={() => reset.mutate(c.id)}>
                        Confirm reset
                      </button>
                      <button className="btn ghost" onClick={() => setConfirming(null)}>
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button className="btn" onClick={() => setConfirming(c.id)}>
                      {c.hasPassword ? 'Reset password' : 'Set password'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data.data && <Pager {...data.data} onPage={(p) => setParams({ page: String(p) })} />}
    </div>
  );
}
