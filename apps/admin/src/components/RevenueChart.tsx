import { formatNaira } from '@yourwifi/shared';
import { useState } from 'react';
import { Panel } from './ui';

interface Point {
  date: string;
  revenueKobo: number;
  orders: number;
}

const H = 160;
const BAR_MAX = 24;

function niceMax(v: number) {
  if (v <= 0) return 100_00;
  const mag = 10 ** Math.floor(Math.log10(v));
  const step = [1, 2, 2.5, 5, 10].find((s) => s * mag >= v)!;
  return step * mag;
}

const compactNaira = (kobo: number) => {
  const n = kobo / 100;
  if (n >= 1_000_000) return `₦${+(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `₦${+(n / 1000).toFixed(1)}K`;
  return `₦${n}`;
};

const dayLabel = (d: string) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** Single-series daily revenue columns: one hue, no legend (the title names it), with a hover tooltip and a table fallback. */
export function RevenueChart({ title, data }: { title: string; data: Point[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);
  const max = niceMax(Math.max(...data.map((d) => d.revenueKobo)));
  const ticks = [0, max / 2, max];
  const peak = data.reduce((best, d, i) => (d.revenueKobo > (data[best]?.revenueKobo ?? 0) ? i : best), 0);
  const h = hover !== null ? data[hover] : null;

  return (
    <Panel
      title={title}
      actions={
        <button className="link" onClick={() => setShowTable((s) => !s)}>
          {showTable ? 'Show chart' : 'Show as table'}
        </button>
      }
    >
      {showTable ? (
        <table className="table compact">
          <thead>
            <tr>
              <th>Day</th>
              <th className="num">Payments</th>
              <th className="num">Revenue</th>
            </tr>
          </thead>
          <tbody>
            {data.map((d) => (
              <tr key={d.date}>
                <td>{dayLabel(d.date)}</td>
                <td className="num">{d.orders}</td>
                <td className="num">{formatNaira(d.revenueKobo)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="chart-body">
          <div className="y-axis" style={{ height: H }}>
            {ticks
              .slice()
              .reverse()
              .map((t) => (
                <span key={t}>{compactNaira(t)}</span>
              ))}
          </div>
          <div className="plot" style={{ height: H }} onMouseLeave={() => setHover(null)}>
            {ticks.map((t) => (
              <div key={t} className="grid" style={{ bottom: `${(t / max) * 100}%` }} />
            ))}
            <div className="cols">
              {data.map((d, i) => {
                const pct = (d.revenueKobo / max) * 100;
                return (
                  <button
                    key={d.date}
                    className={`col ${hover === i ? 'hot' : ''}`}
                    onMouseEnter={() => setHover(i)}
                    onFocus={() => setHover(i)}
                    onBlur={() => setHover(null)}
                    aria-label={`${dayLabel(d.date)}: ${formatNaira(d.revenueKobo)} from ${d.orders} payments`}
                  >
                    <span className="bar" style={{ height: `${pct}%`, maxWidth: BAR_MAX }} />
                    {i === peak && d.revenueKobo > 0 && hover === null && (
                      <span className="cap-label" style={{ bottom: `calc(${pct}% + 4px)` }}>
                        {compactNaira(d.revenueKobo)}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            {h && hover !== null && (
              <div
                className="tooltip"
                style={{
                  left: `${((hover + 0.5) / data.length) * 100}%`,
                  // Keep the tooltip inside the plot near the edges.
                  transform: `translate(${hover < 2 ? '0%' : hover > data.length - 3 ? '-100%' : '-50%'}, -105%)`,
                }}
                role="status"
              >
                <strong>{dayLabel(h.date)}</strong>
                <span>{formatNaira(h.revenueKobo)}</span>
                <span className="muted">
                  {h.orders} payment{h.orders === 1 ? '' : 's'}
                </span>
              </div>
            )}
          </div>
          <div />
          <div className="x-axis">
            {data.map((d, i) => (
              <span key={d.date}>{i % 2 === (data.length - 1) % 2 ? dayLabel(d.date) : ''}</span>
            ))}
          </div>
        </div>
      )}
    </Panel>
  );
}
