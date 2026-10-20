import { formatNaira } from '@yourwifi/shared';
import { useState } from 'react';
import { api } from '../lib';

/** Development-only checkout stand-in. The API serves /api/dev only when PAYMENT_DRIVER=mock. */
export function MockPayPage() {
  const q = new URLSearchParams(location.search);
  const reference = q.get('reference') ?? '';
  const amount = Number(q.get('amount') ?? 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pay = async (outcome: 'success' | 'failed') => {
    setBusy(true);
    try {
      await api.mockPay(reference, outcome);
      location.assign(`/status?reference=${encodeURIComponent(reference)}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <div className="badge warn">Test mode: no real money</div>
      <h1>Simulated checkout</h1>
      <p className="muted">This page stands in for Paystack during development.</p>
      <p className="amount">{formatNaira(amount)}</p>
      <code className="ref">{reference}</code>
      {error && <div className="alert">{error}</div>}
      <div className="stack">
        <button className="btn primary block" disabled={busy} onClick={() => pay('success')}>
          Simulate successful payment
        </button>
        <button className="btn block" disabled={busy} onClick={() => pay('failed')}>
          Simulate failed payment
        </button>
      </div>
    </section>
  );
}
