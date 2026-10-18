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
  const { api, token, user, setUser, clearSession } = useSession();
  const [checking, setChecking] = useState(Boolean(token));
  useEffect(() => {
    let active = true;
    if (!token) { setChecking(false); setUser(null); return; }
    setChecking(true);
    void api.me().then(({ user: current }) => { if (active) setUser(current); }).catch((error) => {
      if (active && error instanceof ApiError && error.status === 401) clearSession();
    }).finally(() => { if (active) setChecking(false); });
    return () => { active = false; };
  }, [api, token, setUser, clearSession]);
  if (checking) return <BootScreen label="Opening your workspace"/>;
  return <Suspense fallback={<BootScreen label="Opening Overroot"/>}><Routes>
    <Route path="/login" element={token && user ? <Navigate to="/" replace/> : <AuthPage mode="login"/>}/>
    <Route path="/register" element={token && user ? <Navigate to="/" replace/> : <AuthPage mode="register"/>}/>
    <Route path="/" element={token && user ? <DashboardPage/> : <Navigate to="/login" replace/>}/>
    <Route path="/project/:hash" element={token && user ? <WorkspacePage/> : <Navigate to="/login" replace/>}/>
    <Route path="*" element={<Navigate to="/" replace/>}/>
  </Routes></Suspense>;
}

function BootScreen({ label = 'Finding the local server' }: { label?: string }) {
  return <div className="boot-screen"><Brand/><LoadingBlock label={label}/></div>;
}

function OfflineScreen({ message, retry }: { message: string; retry: () => void }) {
  return <div className="offline-screen"><Brand/><div className="offline-card"><ServerOff size={28}/><div className="eyebrow">Server sleeping</div><h1>Overroot is offline.</h1><p>{message}. The documents remain safely on the host machine.</p><button type="button" className="primary-button" onClick={retry}><RefreshCw size={15}/> Try again</button></div></div>;
}
