import { RefreshCw, ServerOff } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Brand } from './components/Brand';
import { LoadingBlock } from './components/Feedback';
import { ApiError } from './lib/api';
import { resolveApiBase } from './lib/api-base';
import { SessionProvider, useSession } from './lib/session';

const AuthPage = lazy(() => import('./pages/AuthPage').then((module) => ({ default: module.AuthPage })));
const DashboardPage = lazy(() => import('./pages/DashboardPage').then((module) => ({ default: module.DashboardPage })));
const WorkspacePage = lazy(() => import('./pages/WorkspacePage').then((module) => ({ default: module.WorkspacePage })));

export function App() {
  const [attempt, setAttempt] = useState(0);
  const [apiBase, setApiBase] = useState<string | null>(null);
  const [offline, setOffline] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setOffline(null);
    void resolveApiBase({ envBase: import.meta.env.VITE_API_BASE, dev: import.meta.env.DEV, origin: window.location.origin }).then((base) => { if (active) setApiBase(base); }).catch((error) => {
      if (active) setOffline(error instanceof Error ? error.message : 'The server is offline');
    });
    return () => { active = false; };
  }, [attempt]);

  const reconnect = useCallback(() => {
    setApiBase(null);
    setAttempt((value) => value + 1);
  }, []);

  if (!apiBase && !offline) return <BootScreen/>;
  if (!apiBase) return <OfflineScreen message={offline!} retry={() => setAttempt((value) => value + 1)}/>;
  return <SessionProvider apiBase={apiBase} onNetworkError={reconnect}><SessionGate/></SessionProvider>;
}

function SessionGate() {
  const { api, user, setUser, clearSession } = useSession();
  const [authError, setAuthError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [checking, setChecking] = useState(true);
  useEffect(() => {
    let active = true;
    setChecking(true);
    setAuthError(null);
    void api.me().then(({ user: current }) => { if (active) setUser(current); }).catch((error) => {
      if (!active) return;
      if (error instanceof ApiError && error.status === 401) clearSession();
      else setAuthError(error instanceof Error ? error.message : 'Shared accounts unavailable');
    }).finally(() => { if (active) setChecking(false); });
    return () => { active = false; };
  }, [api, setUser, clearSession, retry]);
  if (authError) return <OfflineScreen message={authError} retry={() => setRetry((value) => value + 1)}/>;
  if (checking) return <BootScreen label="Opening your workspace"/>;
  return <Suspense fallback={<BootScreen label="Opening Overroot"/>}><Routes>
    <Route path="/login" element={user ? <Navigate to="/" replace/> : <AuthPage mode="login"/>}/>
    <Route path="/register" element={user ? <Navigate to="/" replace/> : <AuthPage mode="register"/>}/>
    <Route path="/" element={user ? <DashboardPage/> : <Navigate to="/login" replace/>}/>
    <Route path="/project/:hash" element={user ? <WorkspacePage/> : <Navigate to="/login" replace/>}/>
    <Route path="*" element={<Navigate to="/" replace/>}/>
  </Routes></Suspense>;
}

function BootScreen({ label = 'Connecting to Overroot' }: { label?: string }) {
  return <div className="boot-screen"><Brand/><LoadingBlock label={label}/></div>;
}

function OfflineScreen({ message, retry }: { message: string; retry: () => void }) {
  return <div className="offline-screen"><Brand/><div className="offline-card"><ServerOff size={28}/><div className="eyebrow">Connection unavailable</div><h1>Could not connect to Overroot.</h1><p>{message}. Check your connection and try again.</p><button type="button" className="primary-button" onClick={retry}><RefreshCw size={15}/> Try again</button></div></div>;
}
