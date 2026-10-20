import { bytesRemaining, formatBytes, formatDataMb, type SessionView } from '@yourwifi/shared';
import { formatLagosTime, formatRemaining } from '../lib';

/**
 * Data and time left for one plan. A bundle ends at whichever runs out first, so both meters
 * are shown, and the one closer to running out is listed first.
 */
export function UsageMeter({ session, now = Date.now() }: { session: SessionView; now?: number }) {
  const left = bytesRemaining(session);
  const capBytes = session.dataCapMb !== null ? session.dataCapMb * 1024 * 1024 : null;
  const dataFraction = capBytes ? Math.min(1, session.bytesUsed / capBytes) : null;

  const start = session.startsAt ? new Date(session.startsAt).getTime() : null;
  const end = session.expiresAt ? new Date(session.expiresAt).getTime() : null;
  const timeFraction = start !== null && end !== null && end > start ? Math.min(1, Math.max(0, (now - start) / (end - start))) : null;

  const data = (
    <Meter
      key="data"
      label="Data"
      value={left !== null ? `${formatBytes(left)} left` : 'Unlimited'}
      detail={
        capBytes !== null
          ? `${formatBytes(session.bytesUsed)} of ${formatDataMb(session.dataCapMb!)} used`
          : `${formatBytes(session.bytesUsed)} used`
      }
      fraction={dataFraction}
      low={left !== null && capBytes !== null && left < capBytes * 0.1}
    />
  );
  const time = (
    <Meter
      key="time"
      label="Time"
      value={session.expiresAt ? formatRemaining(session.expiresAt, now) : 'Starts when you connect'}
      detail={session.expiresAt ? `Ends ${formatLagosTime(session.expiresAt)}` : ''}
      fraction={timeFraction}
      low={timeFraction !== null && timeFraction > 0.9}
    />
  );
  const dataFirst = dataFraction !== null && (timeFraction === null || dataFraction >= timeFraction);

  return (
    <div className="meters">
      {dataFirst ? [data, time] : [time, data]}
      {session.usageUpdatedAt && (
        <p className="muted small">Usage updated {formatAgo(session.usageUpdatedAt, now)}</p>
      )}
    </div>
  );
}

function Meter({ label, value, detail, fraction, low }: { label: string; value: string; detail: string; fraction: number | null; low: boolean }) {
  return (
    <div className="meter">
      <div className="meter-head">
        <span className="meter-label">{label}</span>
        <span className="meter-value">{value}</span>
      </div>
      {fraction !== null && (
        <div
          className={`meter-track ${low ? 'low' : ''}`}
          role="meter"
          aria-label={`${label} used`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(fraction * 100)}
        >
          {/* The bar shows what's LEFT, so it shrinks as the plan is used. */}
          <div className="meter-fill" style={{ width: `${(1 - fraction) * 100}%` }} />
        </div>
      )}
      {detail && <span className="muted small">{detail}</span>}
    </div>
  );
}

function formatAgo(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}
