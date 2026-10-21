import { formatNaira, type OrderStatusResponse } from '@yourwifi/shared';
import { VoucherCode } from '../components/VoucherCode';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, formatLagosTime, navigate, signInUrl, store, SUPPORT_PHONE } from '../lib';

const POLL_MS = 3000;
const GIVE_UP_MS = 3 * 60_000;

/** Paystack returns here with ?reference=… This page only displays the result; the backend decides. */
export function StatusPage() {
  const q = new URLSearchParams(location.search);
  const reference = q.get('reference') || q.get('trxref') || store.get('yw:reference');
  const [order, setOrder] = useState<OrderStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const startedAt = useRef(Date.now());
  const triedVerify = useRef(false);

  // A paid order can briefly wait for a voucher (its plan sold out mid-checkout), so keep polling for it.
  const done = (o: OrderStatusResponse | null) => !!o && o.status !== 'pending' && !(o.status === 'success' && !o.voucherCode);

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
        if (!triedVerify.current && Date.now() - startedAt.current > 8000) {
          triedVerify.current = true;
          const v = await api.verify(reference).catch(() => null);
          if (v && !stopped) setOrder(v);
          if (done(v)) return;
        }
      } catch (e) {
        // Some browsers drop cookies across the Paystack redirect.
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

  if (order?.status === 'success') {
    return (
      <div className="stack">
        <section className="card">
          <div className="badge ok">Payment successful</div>
          <h1>Thank you!</h1>
          <p className="muted">Your payment for {order.planName} went through.</p>
          {order.voucherCode ? (
            <>
              <VoucherCode code={order.voucherCode} />
              <p className="note">
                Connect to the Wi-Fi and open any website. When the login page appears, enter this voucher code.
              </p>
            </>
          ) : (
            <p className="note">
              Your voucher code is being prepared. It will appear here and under My purchases shortly.
              {SUPPORT_PHONE && ` If it hasn't appeared within a few minutes, call ${SUPPORT_PHONE}.`}
            </p>
          )}
          <dl className="receipt">
            <dt>Amount</dt>
            <dd>{formatNaira(order.amountKobo)}</dd>
            <dt>Plan</dt>
            <dd>{order.planName}</dd>
            {order.paidAt && (
              <>
                <dt>Paid</dt>
                <dd>{formatLagosTime(order.paidAt)}</dd>
              </>
            )}
            <dt>Reference</dt>
            <dd className="mono">{order.reference}</dd>
          </dl>
          <a className="btn primary block" href="/account">
            View my purchases
          </a>
        </section>
        <a className="btn block" href="/">
          Buy another plan
        </a>
      </div>
    );
  }

  if (order?.status === 'failed') {
    return (
      <section className="card">
        <div className="badge bad">Payment declined</div>
        <h1>Your payment didn't go through</h1>
        <p className="muted">You have not been charged. You can try again with the same or another payment method.</p>
        <code className="ref">{reference}</code>
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

  return (
    <section className="card">
      <div className="spinner" aria-hidden="true" />
      <h1>Confirming your payment…</h1>
      {order && (
        <p className="muted">
          {order.planName} · {formatNaira(order.amountKobo)}
        </p>
      )}
      {error && <div className="alert">{error}</div>}
      {(timedOut || error) && (
        <>
          <p className="muted">If you completed payment, tap below and we'll check with Paystack.</p>
          <button className="btn primary block" onClick={verify} disabled={checking}>
            {checking ? 'Checking…' : 'Check my payment'}
          </button>
        </>
      )}
      <p className="muted small">Reference: {reference}</p>
    </section>
  );
}
