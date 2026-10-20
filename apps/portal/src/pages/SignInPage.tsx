import { useState, type FormEvent } from 'react';
import { useAuth } from '../auth';
import { api, ApiError, navigate, safeNext, store, SUPPORT_PHONE } from '../lib';

type Mode = 'register' | 'login';

export function SignInPage() {
  const { setCustomer } = useAuth();
  const params = new URLSearchParams(location.search);
  const next = safeNext(params.get('next'));
  const [mode, setMode] = useState<Mode>(store.get('yw:phone') ? 'login' : 'register');
  const [phone, setPhone] = useState(store.get('yw:phone') ?? '');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const profile =
        mode === 'register'
          ? await api.register({ phone, password, name: name.trim() || undefined })
          : await api.login({ phone, password });
      store.set('yw:phone', phone);
      setCustomer(profile);
      navigate(next);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setMode('login');
        setError('You already have an account. Enter your password to sign in.');
      } else {
        setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
      }
      setBusy(false);
    }
  };

  const switchMode = (m: Mode) => {
    setMode(m);
    setError(null);
  };

  return (
    <>
      <section className="hero">
        <h1>{mode === 'register' ? 'Create your account' : 'Welcome back'}</h1>
        <p>
          {mode === 'register'
            ? 'Your account keeps your plans in one place, so you can check data and time left anytime.'
            : 'Sign in to buy a plan or check your data and time left.'}
        </p>
      </section>

      <div className="segmented" role="tablist" aria-label="Account">
        <button role="tab" aria-selected={mode === 'register'} className={mode === 'register' ? 'on' : ''} onClick={() => switchMode('register')}>
          Create account
        </button>
        <button role="tab" aria-selected={mode === 'login'} className={mode === 'login' ? 'on' : ''} onClick={() => switchMode('login')}>
          Sign in
        </button>
      </div>

      <form onSubmit={submit} className="stack form-card">
        {mode === 'register' && (
          <div className="field">
            <label htmlFor="name">Your name (optional)</label>
            <input id="name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} disabled={busy} />
          </div>
        )}
        <div className="field">
          <label htmlFor="phone">Phone number</label>
          <input
            id="phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder="0803 123 4567"
            required
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            disabled={busy}
          />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <div className="password">
            <input
              id="password"
              type={showPassword ? 'text' : 'password'}
              autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
              minLength={mode === 'register' ? 8 : undefined}
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
            />
            <button type="button" className="link" onClick={() => setShowPassword((s) => !s)}>
              {showPassword ? 'Hide' : 'Show'}
            </button>
          </div>
          {mode === 'register' && <small className="muted">At least 8 characters.</small>}
        </div>

        {error && <div className="alert">{error}</div>}

        <button className="btn primary block" disabled={busy}>
          {busy ? 'Please wait…' : mode === 'register' ? 'Create account' : 'Sign in'}
        </button>

        {mode === 'login' && (
          <p className="muted small center">
            Forgot your password? {SUPPORT_PHONE ? <>Call {SUPPORT_PHONE} and we'll reset it.</> : 'Contact support to reset it.'}
          </p>
        )}
      </form>
    </>
  );
}
