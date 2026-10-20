import { useEffect, useMemo, useState } from 'react';
import { AuthProvider, useAuth } from './auth';
import { BRAND, captureHotspotContext, signInUrl, SUPPORT_PHONE } from './lib';
import { AccountPage } from './pages/AccountPage';
import { CodePage } from './pages/CodePage';
import { MockPayPage } from './pages/MockPayPage';
import { PlansPage } from './pages/PlansPage';
import { SignInPage } from './pages/SignInPage';
import { StatusPage } from './pages/StatusPage';

// A handful of pages doesn't need a router library.
function usePath() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
  }, []);
  return path;
}

export function App() {
  return (
    <AuthProvider>
      <Shell />
    </AuthProvider>
  );
}

function Shell() {
  const path = usePath();
  const hotspot = useMemo(() => captureHotspotContext(), []);
  const { customer } = useAuth();

  let page;
  if (path.startsWith('/status')) page = <StatusPage hotspot={hotspot} />;
  else if (path.startsWith('/account')) page = <AccountPage hotspot={hotspot} />;
  else if (path.startsWith('/signin')) page = <SignInPage key={location.search} />;
  else if (path.startsWith('/code')) page = <CodePage hotspot={hotspot} />;
  else if (path.startsWith('/mock-pay')) page = <MockPayPage />;
  else page = <PlansPage key={location.search} hotspot={hotspot} />;

  return (
    <div className="shell">
      <header className="brand">
        <a href="/" className="brand-link">
          <svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true">
            <rect width="32" height="32" rx="8" fill="currentColor" />
            <path
              d="M6 13a14 14 0 0 1 20 0M9.5 16.5a9 9 0 0 1 13 0M13 20a4 4 0 0 1 6 0"
              stroke="var(--on-primary)"
              strokeWidth="2.4"
              fill="none"
              strokeLinecap="round"
            />
            <circle cx="16" cy="24" r="1.8" fill="var(--on-primary)" />
          </svg>
          <span>{BRAND}</span>
        </a>
        {customer && !path.startsWith('/account') && (
          <a className="header-link" href="/account">
            My account
          </a>
        )}
        {customer === null && !path.startsWith('/signin') && (
          <a className="header-link" href={signInUrl('/account')}>
            Sign in
          </a>
        )}
      </header>
      <main>{page}</main>
      <footer className="foot">
        {SUPPORT_PHONE ? (
          <>
            Need help? Call <a href={`tel:${SUPPORT_PHONE.replace(/\s/g, '')}`}>{SUPPORT_PHONE}</a>
          </>
        ) : (
          <>Payments secured by Paystack</>
        )}
      </footer>
    </div>
  );
}
