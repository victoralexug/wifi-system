import { formatDataMb, formatNaira, type AccountOrder } from '@yourwifi/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { useAuth } from '../auth';
import { api, ApiError, formatAgo, formatBytes, formatLagosTime, formatSeconds, navigate, signInUrl } from '../lib';

function status(o: AccountOrder): { label: string; tone: string } {
  if (o.status === 'failed') return { label: 'Declined', tone: 'bad' };
  if (o.status === 'flagged') return { label: 'Under review', tone: '' };
  if (o.status !== 'success') return { label: o.status, tone: '' };
  if (!o.voucherCode || !o.state) return { label: 'Being prepared', tone: '' };
  if (o.state === 'expired') return { label: 'Expired', tone: '' };
  if (o.state === 'used_up') return { label: 'Used up', tone: '' };
  if (o.state === 'unused') return { label: 'Not used yet', tone: 'ok' };
  return { label: o.usage?.online ? 'Online now' : 'Active', tone: 'ok' };
}

/** Days and data left on a code that's still valid, with a bar for whichever runs out first. */
function Remaining({ o }: { o: AccountOrder }) {
  if (!o.expiresAt) return null;
  if (o.state === 'expired') return <span className="muted small">Expired {formatLagosTime(o.expiresAt)}</span>;
  if (o.state !== 'active' && o.state !== 'unused') return null;
  const msLeft = Math.max(0, new Date(o.expiresAt).getTime() - Date.now());
  const timeUsed = 1 - msLeft / (o.durationMinutes * 60_000);
  const cap = o.dataCapMb ? o.dataCapMb * 1024 * 1024 : null;
  const bytesLeft = o.usage?.bytesLeft ?? null;
  const dataUsed = cap && bytesLeft !== null ? 1 - bytesLeft / cap : 0;
  const data = !o.dataCapMb ? 'Unlimited data' : bytesLeft !== null ? `${formatBytes(bytesLeft)} left` : formatDataMb(o.dataCapMb);
  return (
    <>
      <span className="small">
        {formatSeconds(msLeft / 1000)} left · {data}
      </span>
      <span className="muted small">Expires {formatLagosTime(o.expiresAt)}</span>
      <span className="meter" aria-hidden="true">
        <span style={{ width: `${Math.round((1 - Math.min(1, Math.max(timeUsed, dataUsed))) * 100)}%` }} />
      </span>
    </>
  );
}

export function AccountPage() {
  const { customer, signOut } = useAuth();
  const [orders, setOrders] = useState<AccountOrder[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (customer === null) navigate(signInUrl('/account'));
  }, [customer]);

  useEffect(() => {
    if (!customer) return;
    api
      .myOrders()
      .then(setOrders)
      .catch((e: Error) => setError(e.message));
  }, [customer]);

  if (!customer) return <div className="skeleton" aria-label="Loading" />;
  const checkedAt = orders?.find((o) => o.usage)?.usage?.checkedAt;

  return (
    <div className="stack">
      <section className="hero compact">
        <h1>{customer.name ? `Hi, ${customer.name.split(' ')[0]}` : 'My account'}</h1>
        <p>{customer.phone}</p>
        {customer.email && <p>{customer.email}</p>}
      </section>

      {error && <div className="alert">{error}</div>}
      {!orders && !error && <div className="skeleton" aria-label="Loading purchases" />}

      {orders?.length === 0 && (
        <section className="card">
          <h2>No purchases yet</h2>
          <p className="muted">Plans you buy show up here.</p>
          <a className="btn primary block" href="/">
            See plans
          </a>
        </section>
      )}

      {orders && orders.length > 0 && (
        <>
          <section className="list">
            <h2>My purchases</h2>
            {checkedAt && <p className="muted small">Usage updated {formatAgo(checkedAt)}</p>}
            {orders.map((o) => {
              const s = status(o);
              return (
                <div key={o.reference} className="list-row">
                  <div>
                    <strong>{o.planName}</strong>
                    <span className="muted small">
                      {formatLagosTime(o.paidAt ?? o.createdAt)} · {formatNaira(o.amountKobo)}
                    </span>
                    {o.voucherCode && (
                      <span className="small">
                        Code: <strong className="mono">{o.voucherCode}</strong>
                      </span>
                    )}
                    {o.voucherCode && <Remaining o={o} />}
                  </div>
                  <span className={`badge ${s.tone}`}>{s.label}</span>
                </div>
              );
            })}
          </section>
          <a className="btn primary block" href="/">
            Buy a plan
          </a>
        </>
      )}

      <ChangeEmail current={customer.email} />
      <ChangePassword />

      <button className="btn block" onClick={() => void signOut().then(() => navigate('/'))}>
        Sign out
      </button>
    </div>
  );
}

// Older accounts may have no email; they need one to reset a forgotten password themselves.
function ChangeEmail({ current }: { current: string | null }) {
  const { setCustomer } = useAuth();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      setCustomer(await api.changeEmail(email, password));
      setStatus({ ok: true, message: 'Email saved.' });
      setEmail('');
      setPassword('');
      setOpen(false);
    } catch (err) {
      setStatus({ ok: false, message: err instanceof ApiError ? err.message : 'Could not save your email.' });
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <div className="center">
        {!current && (
          <div className="note">Add your email so you can reset your password yourself if you ever forget it.</div>
        )}
        {status?.ok && <p className="muted small">{status.message}</p>}
        <button className="link" onClick={() => setOpen(true)}>
          {current ? 'Change email' : 'Add email'}
        </button>
      </div>
    );
  }
  return (
    <form className="card stack left" onSubmit={submit}>
      <h2>{current ? 'Change email' : 'Add email'}</h2>
      <div className="field">
        <label htmlFor="new-email">Email</label>
        <input id="new-email" type="email" inputMode="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="email-password">Current password</label>
        <input id="email-password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
      </div>
      {status && !status.ok && <div className="alert">{status.message}</div>}
      <button className="btn primary block" disabled={busy}>
        {busy ? 'Saving…' : 'Save email'}
      </button>
      <button type="button" className="btn block" onClick={() => setOpen(false)}>
        Cancel
      </button>
    </form>
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
