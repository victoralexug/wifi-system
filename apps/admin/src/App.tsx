import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { NavLink, Navigate, Route, Routes } from 'react-router';
import { api, ApiError } from './api';
import { CustomersPage } from './pages/CustomersPage';
import { LoginPage } from './pages/LoginPage';
import { OrdersPage } from './pages/OrdersPage';
import { OverviewPage } from './pages/OverviewPage';
import { PlansPage } from './pages/PlansPage';
import { VouchersPage } from './pages/VouchersPage';

const NAV = [
  { to: '/', label: 'Overview', end: true },
  { to: '/orders', label: 'Payments' },
  { to: '/customers', label: 'Customers' },
  { to: '/plans', label: 'Plans' },
  { to: '/vouchers', label: 'Vouchers' },
];

export function App() {
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ['me'], queryFn: api.me, retry: false });
  const logout = useMutation({
    mutationFn: api.logout,
    onSuccess: () => qc.clear(),
  });

  if (me.isPending) return <div className="center-screen muted">Loading…</div>;
  if (me.error) {
    if (me.error instanceof ApiError && me.error.status === 401) return <LoginPage />;
    return <div className="center-screen error">Can't reach the API: {me.error.message}</div>;
  }

  return (
    <div className="layout">
      <header className="topbar">
        <div className="logo">
          <img src="/admin/favicon.svg" alt="" width="24" height="24" /> YourWiFi <span className="muted">Admin</span>
        </div>
        <nav className="nav" aria-label="Main">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end}>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="who">
          <span className="muted">{me.data.email}</span>
          <button className="btn ghost" onClick={() => logout.mutate()}>
            Sign out
          </button>
        </div>
      </header>
      <main className="content">
        <Routes>
          <Route path="/" element={<OverviewPage />} />
          <Route path="/orders" element={<OrdersPage />} />
          <Route path="/customers" element={<CustomersPage />} />
          <Route path="/plans" element={<PlansPage />} />
          <Route path="/vouchers" element={<VouchersPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
