import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatBytes, formatDataMb, type AdminSession } from '@yourwifi/shared';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { api, fmtTime } from '../api';
import { Filters, Pager, StatusBadge, useDebounced } from '../components/ui';

export function SessionsPage() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState('');
  const status = params.get('status') ?? '';
  const page = Number(params.get('page') ?? 1);
  const dq = useDebounced(q);
  const qc = useQueryClient();

  const set = (patch: Record<string, string>) => setParams({ status, page: String(page), ...patch });
  const data = useQuery({
    queryKey: ['sessions', page, status, dq],
    queryFn: () => api.sessions({ page, status: status || undefined, q: dq || undefined }),
    placeholderData: keepPreviousData,
    refetchInterval: 15_000,
  });

  const [actionError, setActionError] = useState<string | null>(null);
  const onDone = () => {
    setActionError(null);
    void qc.invalidateQueries({ queryKey: ['sessions'] });
    void qc.invalidateQueries({ queryKey: ['stats'] });
  };
  const revoke = useMutation({ mutationFn: api.revokeSession, onSuccess: onDone, onError: (e) => setActionError(e.message) });
  const retry = useMutation({ mutationFn: api.retrySession, onSuccess: onDone, onError: (e) => setActionError(e.message) });

  // Disconnect asks for confirmation inline on the row rather than with a blocking browser dialog.
  const [pendingRevoke, setPendingRevoke] = useState<string | null>(null);
  const confirmRevoke = (s: AdminSession) => setPendingRevoke(pendingRevoke === s.id ? null : s.id);

  return (
    <div className="stack">
      <h1>Sessions</h1>
      <Filters
        statuses={['active', 'pending', 'expired', 'exhausted', 'revoked']}
        status={status}
        onStatus={(s) => set({ status: s, page: '1' })}
        q={q}
        onQ={(v) => {
          setQ(v);
          if (page !== 1) set({ page: '1' });
        }}
        placeholder="Search code, phone or reference"
      />
      {(data.error || actionError) && <p className="error">{data.error?.message ?? actionError}</p>}
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Code</th>
              <th>Phone</th>
              <th>Plan</th>
              <th>Started</th>
              <th>Expires</th>
              <th className="num">Data used</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.data?.items.map((s) => (
              <tr key={s.id}>
                <td className="mono">{s.voucherCode}</td>
                <td>{s.phone}</td>
                <td>{s.planName}</td>
                <td>{fmtTime(s.startsAt)}</td>
                <td>{fmtTime(s.expiresAt)}</td>
                <td className="num">
                  {formatBytes(s.bytesUsed)}
                  {s.dataCapMb !== null && <div className="muted small">of {formatDataMb(s.dataCapMb)}</div>}
                </td>
                <td>
                  <StatusBadge status={s.status} />
                  {s.lastError && (
                    <div className="muted small" title={s.lastError}>
                      {s.provisionAttempts} attempt{s.provisionAttempts === 1 ? '' : 's'}: {s.lastError.slice(0, 80)}
                    </div>
                  )}
                </td>
                <td className="actions">
                  {s.status === 'pending' && (
                    <button className="btn" disabled={retry.isPending} onClick={() => retry.mutate(s.id)}>
                      Retry now
                    </button>
                  )}
                  {(s.status === 'active' || s.status === 'pending') &&
                    (pendingRevoke === s.id ? (
                      <>
                        <button
                          className="btn danger"
                          disabled={revoke.isPending}
                          onClick={() => revoke.mutate(s.id, { onSettled: () => setPendingRevoke(null) })}
                        >
                          Confirm disconnect
                        </button>
                        <button className="btn ghost" onClick={() => setPendingRevoke(null)}>
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button className="btn" onClick={() => confirmRevoke(s)}>
                        Disconnect
                      </button>
                    ))}
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
