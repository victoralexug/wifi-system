import type { SessionView } from '@yourwifi/shared';
import { useState, type FormEvent } from 'react';
import { ConnectPanel } from '../components/ConnectPanel';
import { api, ApiError, store, type HotspotContext } from '../lib';

export function CodePage({ hotspot }: { hotspot: HotspotContext }) {
  const [code, setCode] = useState(store.get('yw:code') ?? '');
  const [session, setSession] = useState<SessionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSession(null);
    try {
      setSession(await api.lookup(code));
    } catch (err) {
      setError(err instanceof ApiError && err.status === 404 ? "We couldn't find that code. Check it and try again." : (err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  if (session?.status === 'active') return <ConnectPanel session={session} hotspot={hotspot} />;

  return (
    <section className="card">
      <h1>Enter your code</h1>
      <p className="muted">You'll find it on the screen you saw after paying.</p>
      <form onSubmit={submit} className="stack">
        <div className="field">
          <label htmlFor="code">Access code</label>
          <input
            id="code"
            className="code-input"
            autoCapitalize="characters"
            autoComplete="one-time-code"
            spellCheck={false}
            placeholder="ABCD 2345"
            required
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
          />
        </div>
        {session && (
          <div className="alert">
            {session.status === 'pending'
              ? 'Your payment was received and access is being set up. Try again in a minute.'
              : 'This code has expired. Choose a new plan to keep browsing.'}
          </div>
        )}
        {error && <div className="alert">{error}</div>}
        <button className="btn primary block" disabled={loading}>
          {loading ? 'Checking…' : 'Continue'}
        </button>
        <a className="btn block" href="/">
          Buy a new plan
        </a>
      </form>
    </section>
  );
}
