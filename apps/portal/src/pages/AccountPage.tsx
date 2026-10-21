import { formatNaira, type AccountOrder } from '@yourwifi/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { useAuth } from '../auth';
import { api, ApiError, formatLagosTime, navigate, signInUrl } from '../lib';

const STATUS: Record<string, { label: string; tone: string }> = {
  success: { label: 'Paid', tone: 'ok' },
  failed: { label: 'Declined', tone: 'bad' },
  flagged: { label: 'Under review', tone: 'warn' },
};

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
            {orders.map((o) => (
              <div key={o.reference} className="list-row">
                <div>
                  <strong>{o.planName}</strong>
                  <span className="muted small">
                    {formatLagosTime(o.paidAt ?? o.createdAt)} · {formatNaira(o.amountKobo)}
                  </span>
                  {o.status === 'success' && (
                    <span className="small">
                      Voucher: {o.voucherCode ? <strong className="mono">{o.voucherCode}</strong> : <em className="muted">being prepared</em>}
                    </span>
                  )}
                </div>
                <span className={`badge ${STATUS[o.status]?.tone ?? ''}`}>{STATUS[o.status]?.label ?? o.status}</span>
              </div>
            ))}
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
