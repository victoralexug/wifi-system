import { useState, type FormEvent } from 'react';
import { useAuth } from '../auth';
import { api, ApiError, navigate, SUPPORT_PHONE } from '../lib';

const noEmailHelp = SUPPORT_PHONE
  ? `No email on your account? Call ${SUPPORT_PHONE} and we'll reset it for you.`
  : 'No email on your account? Contact support and we will reset it for you.';

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.forgotPassword(email);
      setSent(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  if (sent) {
    return (
      <section className="card">
        <h1>Check your email</h1>
        <p className="muted">
          If an account uses <strong>{email}</strong>, we've sent it a link to choose a new password. The link works for
          30 minutes.
        </p>
        <p className="muted small">Not there? Check your spam folder, or try again in a few minutes.</p>
        <a className="btn block" href="/signin">
          Back to sign in
        </a>
      </section>
    );
  }

  return (
    <>
      <section className="hero">
        <h1>Forgot your password?</h1>
        <p>Enter the email on your account and we'll send you a link to choose a new one.</p>
      </section>
      <form onSubmit={submit} className="stack form-card">
        <div className="field">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={busy}
          />
        </div>
        {error && <div className="alert">{error}</div>}
        <button className="btn primary block" disabled={busy}>
          {busy ? 'Please wait…' : 'Send reset link'}
        </button>
        <p className="muted small center">{noEmailHelp}</p>
      </form>
    </>
  );
}

export function ResetPasswordPage() {
  const { setCustomer } = useAuth();
  // The token arrives in the URL fragment. Take it once, then drop it from the address bar and history.
  const [token] = useState(() => {
    const t = location.hash.slice(1);
    if (t) history.replaceState(null, '', location.pathname);
    return t;
  });
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setCustomer(await api.resetPassword({ token, password }));
      navigate('/account');
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, 'Something went wrong. Please try again.'));
      setBusy(false);
    }
  };

  if (!token) {
    return (
      <section className="card">
        <h1>Link not complete</h1>
        <p className="muted">Open the link from your email again, or ask for a new one.</p>
        <a className="btn primary block" href="/forgot-password">
          Send a new link
        </a>
      </section>
    );
  }

  return (
    <>
      <section className="hero">
        <h1>Choose a new password</h1>
        <p>You'll be signed in once it's saved.</p>
      </section>
      <form onSubmit={submit} className="stack form-card">
        <div className="field">
          <label htmlFor="password">New password</label>
          <div className="password">
            <input
              id="password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="new-password"
              minLength={8}
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
            />
            <button type="button" className="link" onClick={() => setShowPassword((s) => !s)}>
              {showPassword ? 'Hide' : 'Show'}
            </button>
          </div>
          <small className="muted">At least 8 characters.</small>
        </div>
        {error && (
          <div className="alert">
            {error.message}{' '}
            {error.code === 'invalid_reset_token' && (
              <a href="/forgot-password" className="link">
                Send a new link
              </a>
            )}
          </div>
        )}
        <button className="btn primary block" disabled={busy}>
          {busy ? 'Saving…' : 'Save new password'}
        </button>
      </form>
    </>
  );
}
