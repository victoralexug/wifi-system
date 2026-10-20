import { useQuery } from '@tanstack/react-query';
import { api, fmtTime } from '../api';
import { Panel, StatusBadge } from '../components/ui';

const mb = (b: number | null) => (b === null ? '—' : `${(b / 1024 / 1024).toFixed(1)} MB`);

export function NetworkPage() {
  const net = useQuery({ queryKey: ['network'], queryFn: api.network, refetchInterval: 15_000 });

  if (net.isPending) return <p className="muted">Loading…</p>;
  if (net.error) return <p className="error">{net.error.message}</p>;
  const { devices, active, activeError } = net.data;

  return (
    <div className="stack">
      <h1>Network</h1>
      <Panel title="Controllers">
        {devices.length === 0 && <p className="muted">No health check has run yet.</p>}
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Driver</th>
                <th>Identity</th>
                <th>Status</th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {devices.map((d) => (
                <tr key={d.id}>
                  <td>
                    <strong>{d.name}</strong>
                  </td>
                  <td>
                    {d.driver}
                    {d.driver === 'mock' && <div className="muted small">Simulated, not a real router</div>}
                  </td>
                  <td>{d.identity ?? '—'}</td>
                  <td>
                    <StatusBadge status={d.status} />
                    {d.lastError && <div className="muted small">{d.lastError}</div>}
                  </td>
                  <td>{fmtTime(d.lastSeenAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title={`Connected devices (${active.length})`}>
        {activeError && <p className="error">Couldn't read live connections: {activeError}</p>}
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Code</th>
                <th>IP address</th>
                <th>MAC</th>
                <th>Uptime</th>
                <th className="num">Download</th>
                <th className="num">Upload</th>
              </tr>
            </thead>
            <tbody>
              {active.map((a) => (
                <tr key={`${a.user}-${a.macAddress}`}>
                  <td className="mono">{a.user}</td>
                  <td>{a.address ?? '—'}</td>
                  <td className="mono">{a.macAddress ?? '—'}</td>
                  <td>{a.uptime ?? '—'}</td>
                  {/* RouterOS counts from the router's side: bytes-out is what the client downloaded. */}
                  <td className="num">{mb(a.bytesOut)}</td>
                  <td className="num">{mb(a.bytesIn)}</td>
                </tr>
              ))}
              {active.length === 0 && !activeError && (
                <tr>
                  <td colSpan={6} className="muted">
                    Nobody is connected right now.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
