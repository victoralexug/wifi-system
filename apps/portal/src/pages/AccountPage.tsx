import { formatNaira, type AccountSession } from '@yourwifi/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { useAuth } from '../auth';
import { ConnectPanel } from '../components/ConnectPanel';
import { UsageMeter } from '../components/UsageMeter';
import { api, ApiError, formatLagosTime, navigate, signInUrl, type HotspotContext } from '../lib';

const ENDED: Record<string, string> = {
  expired: 'Time ran out',
  exhausted: 'Data used up',
  revoked: 'Disconnected',
};

export function AccountPage({ hotspot }: { hotspot: HotspotContext }) {
  const { customer, signOut } = useAuth();
  const [sessions, setSessions] = useState<AccountSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (customer === null) navigate(signInUrl('/account'));
  }, [customer]);

  useEffect(() => {
    if (!customer) return;
    let stopped = false;
    const load = () =>
      api
        .mySessions()
        .then((s) => {
          if (!stopped) {
            setSessions(s);
            setNow(Date.now());
            setError(null);
          }
        })
        .catch((e) => !stopped && setError((e as Error).message));
    void load();
    // Usage is read from the router every ~30 s; refresh to match.
    const t = setInterval(load, 30_000);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [customer]);

  if (!customer) return <div className="skeleton" aria-label="Loading" />;

  const live = sessions?.filter((s) => s.status === 'active' || s.status === 'pending') ?? [];
  const past = sessions?.filter((s) => !(s.status === 'active' || s.status === 'pending')) ?? [];

  return (
    <div className="stack">
      <section className="hero compact">
        <h1>{customer.name ? `Hi, ${customer.name.split(' ')[0]}` : 'My account'}</h1>
        <p>{customer.phone}</p>
      </section>

      {error && <div className="alert">{error}</div>}
      {!sessions && !error && <div className="skeleton" aria-label="Loading plans" />}

      {sessions && live.length === 0 && (
        <section className="card">
          <h2>No active plan</h2>
          <p className="muted">Buy a plan to get online. It shows up here with your data and time left.</p>
          <a className="btn primary block" href="/">
            See plans
          </a>
        </section>
      )}

      {live.map((s) =>
        s.status === 'active' ? (
          <ConnectPanel key={s.id} session={s} hotspot={hotspot} now={now} />
        ) : (
          <section key={s.id} className="card">
            <div className="badge">Setting up</div>
            <h2>{s.planName}</h2>
            <p className="muted">Payment received. Your access turns on automatically in a moment.</p>
            <UsageMeter session={s} now={now} />
          </section>
        ),
      )}

      {live.length > 0 && (
        <a className="btn block" href="/">
          Buy another plan
        </a>
      )}

      {past.length > 0 && (
        <section className="list">
          <h2>Past plans</h2>
          {past.map((s) => (
            <div key={s.id} className="list-row">
              <div>
                <strong>{s.planName}</strong>
                <span className="muted small">
                  {formatLagosTime(s.createdAt)} · {formatNaira(s.amountKobo)}
                </span>
              </div>
              <span className="muted small">{ENDED[s.status] ?? s.status}</span>
            </div>
          ))}
        </section>
      )}

      <ChangePassword />

      <button className="btn block" onClick={() => void signOut().then(() => navigate('/'))}>
        Sign out
      </button>
    </div>
  );
}

function ChangePassword() {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.changePassword(current, next);
      setStatus({ ok: true, message: 'Password changed.' });
      setCurrent('');
      setNext('');
      setOpen(false);
    } catch (err) {
      setStatus({ ok: false, message: err instanceof ApiError ? err.message : 'Could not change password.' });
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <div className="center">
        {status?.ok && <p className="muted small">{status.message}</p>}
        <button className="link" onClick={() => setOpen(true)}>
          Change password
        </button>
      </div>
    );
  }
  return (
    <form className="card stack left" onSubmit={submit}>
      <h2>Change password</h2>
      <div className="field">
        <label htmlFor="current">Current password</label>
        <input id="current" type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="new">New password</label>
        <input id="new" type="password" autoComplete="new-password" minLength={8} required value={next} onChange={(e) => setNext(e.target.value)} />
      </div>
      {status && !status.ok && <div className="alert">{status.message}</div>}
      <button className="btn primary block" disabled={busy}>
        {busy ? 'Saving…' : 'Save new password'}
      </button>
      <button type="button" className="btn block" onClick={() => setOpen(false)}>
        Cancel
      </button>
    </form>
  );
}
