import { formatDataMb, formatNaira, type AccountOrder, type CustomerProfile } from '@yourwifi/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { useAuth } from '../auth';
import { api, ApiError, formatAgo, formatBytes, formatLagosTime, formatSeconds, navigate, signInUrl } from '../lib';

const HISTORY_PREVIEW = 3;

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

/** Paid and still usable, or about to be: these lead the page. Everything else is history. */
const isCurrent = (o: AccountOrder) => o.status === 'success' && (o.state === null || o.state === 'active' || o.state === 'unused');

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
  const current = orders?.filter(isCurrent) ?? [];
  const past = orders?.filter((o) => !isCurrent(o)) ?? [];
  const checkedAt = orders?.find((o) => o.usage)?.usage?.checkedAt;

  return (
    <div className="stack account">
      <h1 className="greeting">{customer.name ? `Hi, ${customer.name.split(' ')[0]}` : 'My plans'}</h1>

      {error && <div className="alert">{error}</div>}
      {!orders && !error && <div className="skeleton" aria-label="Loading your plans" />}

      {orders && (
        <section className="stack" aria-label="Your plans">
          {current.length === 0 ? (
            <div className="pass empty">
              <strong>No active plan</strong>
              <span className="muted small">Buy one and your code shows up here.</span>
            </div>
          ) : (
            current.map((o) => <Pass key={o.reference} o={o} />)
          )}
          {checkedAt && current.length > 0 && <p className="muted small center">Usage updated {formatAgo(checkedAt)}</p>}
        </section>
      )}

      {past.length > 0 && <History orders={past} />}

      <AccountSettings customer={customer} onSignOut={() => void signOut().then(() => navigate('/'))} />

      <div className="sticky-cta">
        <a className="btn primary block" href="/">
          Buy a plan
        </a>
      </div>
    </div>
  );
}

/** A code that's valid now: the code first, then how much is left. */
function Pass({ o }: { o: AccountOrder }) {
  const s = status(o);
  return (
    <article className="pass">
      <div className="pass-head">
        <strong>{o.planName}</strong>
        <span className={`badge ${s.tone}`}>{s.label}</span>
      </div>
      {o.voucherCode ? <CopyCode code={o.voucherCode} /> : <p className="muted small">Your code will appear here shortly.</p>}
      <Remaining o={o} />
    </article>
  );
}

function CopyCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be blocked in in-app browsers; the code is still on screen.
    }
  };
  return (
    <button type="button" className="pass-code" onClick={copy} aria-label={`Voucher code ${code}, tap to copy`}>
      <span className="mono">{code}</span>
      <span className="small">{copied ? 'Copied' : 'Copy'}</span>
    </button>
  );
}

/** Time and data left, with a bar for whichever runs out first. */
function Remaining({ o }: { o: AccountOrder }) {
  if (!o.expiresAt) return null;
  const msLeft = Math.max(0, new Date(o.expiresAt).getTime() - Date.now());
  const timeUsed = 1 - msLeft / (o.durationMinutes * 60_000);
  const cap = o.dataCapMb ? o.dataCapMb * 1024 * 1024 : null;
  const bytesLeft = o.usage?.bytesLeft ?? null;
  const dataUsed = cap && bytesLeft !== null ? 1 - bytesLeft / cap : 0;
  const data = !o.dataCapMb ? 'Unlimited' : bytesLeft !== null ? formatBytes(bytesLeft) : formatDataMb(o.dataCapMb);
  return (
    <>
      <span className="meter" aria-hidden="true">
        <span style={{ width: `${Math.round((1 - Math.min(1, Math.max(timeUsed, dataUsed))) * 100)}%` }} />
      </span>
      <dl className="pass-stats">
        <div>
          <dt>Time left</dt>
          <dd>{formatSeconds(msLeft / 1000)}</dd>
        </div>
        <div>
          <dt>{o.dataCapMb ? 'Data left' : 'Data'}</dt>
          <dd>{data}</dd>
        </div>
      </dl>
      <span className="muted small">Expires {formatLagosTime(o.expiresAt)}</span>
    </>
  );
}

/** Expired, used up and declined purchases, newest first. Only the latest few until asked. */
function History({ orders }: { orders: AccountOrder[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? orders : orders.slice(0, HISTORY_PREVIEW);
  return (
    <section className="list">
      <h2 className="section-label">History</h2>
      {shown.map((o) => {
        const s = status(o);
        return (
          <div key={o.reference} className="list-row">
            <div>
              <span>{o.planName}</span>
              <span className="muted small">
                {formatLagosTime(o.paidAt ?? o.createdAt)} · {formatNaira(o.amountKobo)}
              </span>
            </div>
            <span className={`badge ${s.tone}`}>{s.label}</span>
          </div>
        );
      })}
      {orders.length > HISTORY_PREVIEW && (
        <button className="link" onClick={() => setAll(!all)}>
          {all ? 'Show less' : `Show all ${orders.length}`}
        </button>
      )}
    </section>
  );
}

/** Contact details and sign-in settings: kept compact, below the plans. */
function AccountSettings({ customer, onSignOut }: { customer: CustomerProfile; onSignOut: () => void }) {
  const [editing, setEditing] = useState<'email' | 'password' | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const done = (message: string) => {
    setEditing(null);
    setSaved(message);
  };
  return (
    <section className="list">
      <h2 className="section-label">Account</h2>
      <div className="setting">
        <div>
          <span className="muted small">Phone</span>
          <span>{customer.phone}</span>
        </div>
      </div>
      <div className="setting">
        <div>
          <span className="muted small">Email</span>
          <span>{customer.email ?? 'Not added'}</span>
        </div>
        {editing !== 'email' && (
          <button className="link" onClick={() => setEditing('email')}>
            {customer.email ? 'Change' : 'Add'}
          </button>
        )}
      </div>
      {!customer.email && editing !== 'email' && (
        <p className="note">Add an email so you can reset your password yourself.</p>
      )}
      {editing === 'email' && <ChangeEmail current={customer.email} onDone={done} onCancel={() => setEditing(null)} />}
      <div className="setting">
        <div>
          <span className="muted small">Password</span>
          <span>••••••••</span>
        </div>
        {editing !== 'password' && (
          <button className="link" onClick={() => setEditing('password')}>
            Change
          </button>
        )}
      </div>
      {editing === 'password' && <ChangePassword onDone={done} onCancel={() => setEditing(null)} />}
      {saved && <p className="muted small">{saved}</p>}
      <div className="setting">
        <button className="link quiet" onClick={onSignOut}>
          Sign out
        </button>
      </div>
    </section>
  );
}

type FormProps = { onDone: (message: string) => void; onCancel: () => void };

function ChangeEmail({ current, onDone, onCancel }: FormProps & { current: string | null }) {
  const { setCustomer } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      setCustomer(await api.changeEmail(email, password));
      onDone('Email saved.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save your email.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="stack setting-form" onSubmit={submit}>
      <div className="field">
        <label htmlFor="new-email">{current ? 'New email' : 'Email'}</label>
        <input id="new-email" type="email" inputMode="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="email-password">Current password</label>
        <input id="email-password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
      </div>
      {error && <div className="alert">{error}</div>}
      <div className="row">
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn" disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}

function ChangePassword({ onDone, onCancel }: FormProps) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.changePassword(current, next);
      onDone('Password changed.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change password.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="stack setting-form" onSubmit={submit}>
      <div className="field">
        <label htmlFor="current">Current password</label>
        <input id="current" type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="new">New password</label>
        <input id="new" type="password" autoComplete="new-password" minLength={8} required value={next} onChange={(e) => setNext(e.target.value)} />
      </div>
      {error && <div className="alert">{error}</div>}
      <div className="row">
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn" disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}
