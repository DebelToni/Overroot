import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ApiClient } from './api';
import type { User } from '../types';

interface SessionContextValue {
  api: ApiClient;
  user: User | null;
  clearSession: () => void;
  setUser: (user: User | null) => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ apiBase, onNetworkError, children }: { apiBase: string; onNetworkError: () => void; children: ReactNode }) {
  useEffect(() => { localStorage.removeItem('overroot.session'); }, []);
  const [user, setUser] = useState<User | null>(null);

  const clearSession = useCallback(() => {
    localStorage.removeItem('overroot.session');
    setUser(null);
  }, []);
  const api = useMemo(
    () => new ApiClient(apiBase, clearSession, onNetworkError),
    [apiBase, clearSession, onNetworkError]
  );
  const value = useMemo(
    () => ({ api, user, clearSession, setUser }),
    [api, user, clearSession]
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside SessionProvider');
  return value;
}
