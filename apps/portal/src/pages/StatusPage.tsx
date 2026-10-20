import { formatNaira, type OrderStatusResponse } from '@yourwifi/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ConnectPanel } from '../components/ConnectPanel';
import { api, ApiError, navigate, signInUrl, store, SUPPORT_PHONE, type HotspotContext } from '../lib';

const POLL_MS = 3000;
const GIVE_UP_MS = 3 * 60_000;

/** Paystack returns here with ?reference=… This page only displays status; the backend decides. */
export function StatusPage({ hotspot }: { hotspot: HotspotContext }) {
  const q = new URLSearchParams(location.search);
  const reference = q.get('reference') || q.get('trxref') || store.get('yw:reference');
  const [order, setOrder] = useState<OrderStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const startedAt = useRef(Date.now());
  const triedVerify = useRef(false);

  const done = (o: OrderStatusResponse | null) =>
    !!o && (o.status === 'failed' || o.status === 'flagged' || o.session?.status === 'active');

  const verify = useCallback(async () => {
    if (!reference) return;
    setChecking(true);
    try {
      setOrder(await api.verify(reference));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setChecking(false);
    }
  }, [reference]);

  useEffect(() => {
    if (!reference) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const o = await api.order(reference);
        if (stopped) return;
        setOrder(o);
        setError(null);
        if (done(o)) return;
        // The webhook is normally faster. If it's late, ask the backend to check with Paystack once.
        if (!triedVerify.current && o.status === 'pending' && Date.now() - startedAt.current > 8000) {
          triedVerify.current = true;
          const v = await api.verify(reference).catch(() => null);
          if (v && !stopped) setOrder(v);
          if (done(v)) return;
        }
      } catch (e) {
        // Captive-portal browsers sometimes drop cookies across the Paystack redirect.
        if (e instanceof ApiError && e.status === 401) {
          navigate(signInUrl(`/status?reference=${encodeURIComponent(reference)}`));
          return;
        }
        if (!stopped) setError((e as Error).message);
      }
      if (Date.now() - startedAt.current > GIVE_UP_MS) {
        setTimedOut(true);
        return;
      }
      timer = setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [reference]);

  if (!reference) {
    return (
      <section className="card">
        <h1>No payment found</h1>
        <p className="muted">We couldn't find a payment to check on this device.</p>
        <a className="btn primary block" href="/">
          See plans
        </a>
      </section>
    );
  }

  if (order?.session?.status === 'active') {
    return (
      <div className="stack">
        <section className="hero compact">
          <h1>You're all set</h1>
          <p>Payment received. You can check your data and time left anytime in My account.</p>
        </section>
        <ConnectPanel session={order.session} hotspot={hotspot} />
        <a className="btn block" href="/account">
          Go to My account
        </a>
      </div>
    );
  }

  if (order?.status === 'failed') {
    return (
      <section className="card">
        <div className="badge bad">Payment not completed</div>
        <h1>Your payment didn't go through</h1>
        <p className="muted">You have not been charged for internet access. You can try again.</p>
        <a className="btn primary block" href="/">
          Try again
        </a>
      </section>
    );
  }

  if (order?.status === 'flagged') {
    return (
      <section className="card">
        <div className="badge warn">Under review</div>
        <h1>We're checking your payment</h1>
        <p className="muted">
          Something about this payment needs a manual check. Contact support{SUPPORT_PHONE && ` on ${SUPPORT_PHONE}`} with
          this reference:
        </p>
        <code className="ref">{reference}</code>
      </section>
    );
  }

  const paid = order?.status === 'success';
  return (
    <section className="card">
      <div className="spinner" aria-hidden="true" />
      <h1>{paid ? 'Payment received. Turning on your internet…' : 'Confirming your payment…'}</h1>
      {order && (
        <p className="muted">
          {order.planName} · {formatNaira(order.amountKobo)}
        </p>
      )}
      {paid && order?.session?.status === 'pending' && (
        <p className="note">Your access code is {order.session.voucherCode}. It will start working in a moment.</p>
      )}
      {error && <div className="alert">{error}</div>}
      {(timedOut || error) && (
        <>
          <p className="muted">
            {paid
              ? 'This is taking longer than usual. Your payment is safe, and access will turn on automatically.'
              : "If you completed payment, tap below and we'll check with Paystack."}
          </p>
          <button className="btn primary block" onClick={verify} disabled={checking}>
            {checking ? 'Checking…' : 'Check my payment'}
          </button>
        </>
      )}
      <p className="muted small">Reference: {reference}</p>
    </section>
  );
}
