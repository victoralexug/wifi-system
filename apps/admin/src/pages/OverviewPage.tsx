import { useQuery } from '@tanstack/react-query';
import { formatNaira } from '@yourwifi/shared';
import { Link } from 'react-router';
import { api } from '../api';
import { RevenueChart } from '../components/RevenueChart';
import { Panel, StatusBadge } from '../components/ui';

export function OverviewPage() {
  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats, refetchInterval: 30_000 });
  const network = useQuery({ queryKey: ['network'], queryFn: api.network, refetchInterval: 30_000 });

  if (stats.isPending) return <p className="muted">Loading…</p>;
  if (stats.error) return <p className="error">{stats.error.message}</p>;
  const s = stats.data;
  const device = network.data?.devices[0];

  return (
    <div className="stack">
      <h1>Overview</h1>

      {(s.pendingProvisioning > 0 || s.orders.flagged > 0 || device?.status === 'offline') && (
        <div className="attention">
          {device?.status === 'offline' && (
            <p>
              <StatusBadge status="offline" /> Router <strong>{device.name}</strong> is unreachable: {device.lastError}.{' '}
              <Link to="/network">Details</Link>
            </p>
          )}
          {s.pendingProvisioning > 0 && (
            <p>
              <StatusBadge status="pending" /> {s.pendingProvisioning} paid session{s.pendingProvisioning === 1 ? ' is' : 's are'} waiting
              for the router. <Link to="/sessions?status=pending">Review</Link>
            </p>
          )}
          {s.orders.flagged > 0 && (
            <p>
              <StatusBadge status="flagged" /> {s.orders.flagged} payment{s.orders.flagged === 1 ? '' : 's'} flagged for an amount
              mismatch. <Link to="/orders?status=flagged">Review</Link>
            </p>
          )}
        </div>
      )}

      <div className="tiles">
        <Tile label="Revenue today" value={formatNaira(s.revenueKobo.today)} />
        <Tile label="Last 7 days" value={formatNaira(s.revenueKobo.last7Days)} />
        <Tile label="Last 30 days" value={formatNaira(s.revenueKobo.last30Days)} />
        <Tile label="Online now" value={String(s.activeSessions)} hint="active sessions" />
      </div>

      <Panel title="Daily revenue, last 14 days">
        <RevenueChart data={s.dailyRevenue} />
      </Panel>

      <Panel title="Payments">
        <div className="tiles small">
          <Tile label="Paid" value={String(s.orders.success)} />
          <Tile label="Pending" value={String(s.orders.pending)} />
          <Tile label="Failed" value={String(s.orders.failed)} />
          <Tile label="Flagged" value={String(s.orders.flagged)} />
        </div>
      </Panel>
    </div>
  );
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="tile">
      <span className="tile-label">{label}</span>
      <span className="tile-value">{value}</span>
      {hint && <span className="muted small">{hint}</span>}
    </div>
  );
}
