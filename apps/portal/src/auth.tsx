import type { CustomerProfile } from '@yourwifi/shared';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from './lib';

interface AuthState {
  /** undefined while checking, null when signed out. */
  customer: CustomerProfile | null | undefined;
  setCustomer: (c: CustomerProfile | null) => void;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [customer, setCustomer] = useState<CustomerProfile | null | undefined>(undefined);

  useEffect(() => {
    // Any failure (signed out, or the API unreachable) shows the signed-out experience.
    api
      .me()
      .then(setCustomer)
      .catch(() => setCustomer(null));
  }, []);

  const signOut = useCallback(async () => {
    await api.logout().catch(() => undefined);
    setCustomer(null);
  }, []);

  return <AuthContext.Provider value={{ customer, setCustomer, signOut }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
