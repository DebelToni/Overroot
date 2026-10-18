import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { ApiClient } from './api';
import type { User } from '../types';

const SESSION_KEY = 'overroot.session';

interface SessionContextValue {
  api: ApiClient;
  token: string | null;
  user: User | null;
  setSession: (token: string, user: User) => void;
  clearSession: () => void;
  setUser: (user: User | null) => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ apiBase, onNetworkError, children }: { apiBase: string; onNetworkError: () => void; children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(SESSION_KEY));
  const [user, setUser] = useState<User | null>(null);

  const clearSession = useCallback(() => {
    localStorage.removeItem(SESSION_KEY);
    setToken(null);
    setUser(null);
  }, []);
  const setSession = useCallback((nextToken: string, nextUser: User) => {
    localStorage.setItem(SESSION_KEY, nextToken);
    setToken(nextToken);
    setUser(nextUser);
  }, []);

  const api = useMemo(
    () => new ApiClient(apiBase, () => localStorage.getItem(SESSION_KEY), clearSession, onNetworkError),
    [apiBase, clearSession, onNetworkError]
  );
  const value = useMemo(
    () => ({ api, token, user, setSession, clearSession, setUser }),
    [api, token, user, setSession, clearSession]
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside SessionProvider');
  return value;
}
