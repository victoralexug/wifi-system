import { useEffect, useState, type ReactNode } from 'react';

const STATUS: Record<string, { tone: 'good' | 'warning' | 'critical' | 'neutral'; label: string }> = {
  success: { tone: 'good', label: 'Paid' },
  active: { tone: 'good', label: 'Active' },
  online: { tone: 'good', label: 'Online' },
  pending: { tone: 'warning', label: 'Pending' },
  flagged: { tone: 'critical', label: 'Flagged' },
  failed: { tone: 'critical', label: 'Failed' },
  offline: { tone: 'critical', label: 'Offline' },
  revoked: { tone: 'neutral', label: 'Revoked' },
  expired: { tone: 'neutral', label: 'Expired' },
  exhausted: { tone: 'neutral', label: 'Data used up' },
  unknown: { tone: 'neutral', label: 'Unknown' },
};

const ICON = { good: '●', warning: '◐', critical: '▲', neutral: '○' };

/** Status is always icon + text, never color alone. */
export function StatusBadge({ status }: { status: string }) {
  const s = STATUS[status] ?? { tone: 'neutral' as const, label: status };
  return (
    <span className={`status ${s.tone}`}>
      <span aria-hidden="true">{ICON[s.tone]}</span> {s.label}
    </span>
  );
}

export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="pager">
      <span className="muted">
        {total === 0 ? 'No results' : `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)} of ${total}`}
      </span>
      <div>
        <button className="btn" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          Previous
        </button>
        <button className="btn" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          Next
        </button>
      </div>
    </div>
  );
}

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function Filters({
  statuses,
  status,
  onStatus,
  q,
  onQ,
  placeholder,
}: {
  statuses: string[];
  status: string;
  onStatus: (s: string) => void;
  q: string;
  onQ: (q: string) => void;
  placeholder: string;
}) {
  return (
    <div className="filters">
      <input type="search" placeholder={placeholder} value={q} onChange={(e) => onQ(e.target.value)} aria-label="Search" />
      <div className="segmented" role="group" aria-label="Filter by status">
        {['', ...statuses].map((s) => (
          <button key={s || 'all'} className={s === status ? 'on' : ''} onClick={() => onStatus(s)}>
            {s ? (STATUS[s]?.label ?? s) : 'All'}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Panel({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}
