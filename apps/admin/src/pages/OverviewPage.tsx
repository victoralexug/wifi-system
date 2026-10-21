import { useQuery } from '@tanstack/react-query';
import { formatNaira } from '@yourwifi/shared';
import { Link } from 'react-router';
import { api } from '../api';
import { RevenueChart } from '../components/RevenueChart';
import { Panel, StatusBadge } from '../components/ui';

export function OverviewPage() {
  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats, refetchInterval: 30_000 });

  if (stats.isPending) return <p className="muted">Loading…</p>;
  if (stats.error) return <p className="error">{stats.error.message}</p>;
  const s = stats.data;
  const soldOut = s.lowVoucherStock.filter((p) => p.available === 0);
  const low = s.lowVoucherStock.filter((p) => p.available > 0);

  return (
    <div className="stack">
      <h1>Overview</h1>

      {(s.orders.flagged > 0 || s.ordersWaitingForVoucher > 0 || s.lowVoucherStock.length > 0) && (
        <div className="attention">
          {s.ordersWaitingForVoucher > 0 && (
            <p>
              <StatusBadge status="waiting" /> {s.ordersWaitingForVoucher} paid order{s.ordersWaitingForVoucher === 1 ? ' is' : 's are'}{' '}
              waiting for a voucher code because the plan ran out. Add codes and they're given out straight away.{' '}
              <Link to="/vouchers">Add codes</Link>
            </p>
          )}
          {soldOut.length > 0 && (
            <p>
              <StatusBadge status="sold_out" /> No voucher codes left, so customers can't buy:{' '}
              <strong>{soldOut.map((p) => p.planName).join(', ')}</strong>. <Link to="/vouchers">Add codes</Link>
            </p>
          )}
          {low.length > 0 && (
            <p>
              <StatusBadge status="low" /> Running low on voucher codes:{' '}
              <strong>{low.map((p) => `${p.planName} (${p.available} left)`).join(', ')}</strong>. <Link to="/vouchers">Add codes</Link>
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
