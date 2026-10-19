import { ArrowRight, FileText, KeyRound, Layers, Users } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Brand } from '../components/Brand';
import { InlineError } from '../components/Feedback';
import { ThemeControl } from '../components/ThemeControl';
import { useTheme } from '../hooks/useTheme';
import { useSession } from '../lib/session';

export function AuthPage({ mode }: { mode: 'login' | 'register' }) {
  const { api, setSession, token } = useSession();
  const theme = useTheme();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [invite, setInvite] = useState(params.get('invite') ?? '');
  const [busy, setBusy] = useState(false);
  const [setupRequired, setSetupRequired] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (token) navigate('/', { replace: true });
    void api.request<{ setupRequired: boolean }>('/api/v1/status').then((status) => setSetupRequired(status.setupRequired)).catch(() => {});
  }, [api, token, navigate]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError(null);
    try {
      const session = mode === 'login' ? await api.login(username, password) : await api.register(invite, username, password);
      setSession(session.token, session.user);
      navigate('/', { replace: true });
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Authentication failed'); }
    finally { setBusy(false); }
  }

  return <div className="auth-shell">
    <header className="auth-head"><Brand/><ThemeControl value={theme.preference} onChange={theme.setPreference}/></header>
    <div className="accent-line"/>
    <main className="auth-main">
      <section className="auth-story">
        <h1>Collaborative LaTeX</h1>
        <p>Write, compile, and share LaTeX projects with people and agents.</p>
        <div className="auth-proof"><span><FileText size={16} aria-hidden="true"/> Live writing</span><span><Layers size={16} aria-hidden="true"/> Modular sources</span><span><Users size={16} aria-hidden="true"/> Shared workspace</span></div>
      </section>
      <section className="auth-panel" aria-labelledby="auth-title">
        <div className="auth-panel__label"><KeyRound size={14} aria-hidden="true"/>{mode === 'login' ? 'Member access' : 'Use invitation'}</div>
        <h2 id="auth-title">{mode === 'login' ? 'Sign in' : 'Create an account'}</h2>
        <p>{mode === 'login' ? 'Use your Overroot username and password.' : 'An invitation, username, and password are required.'}</p>
        {setupRequired && mode === 'login' && <div className="setup-note"><strong>First-time setup is required.</strong><span>Create the administrator from the local terminal with <code>pnpm admin:create</code>.</span></div>}
        <form onSubmit={submit} className="auth-form">
          {mode === 'register' && <label className="field"><span>Invitation</span><input value={invite} onChange={(event) => setInvite(event.target.value)} required autoComplete="off"/></label>}
          <label className="field"><span>Username</span><input value={username} onChange={(event) => setUsername(event.target.value)} required minLength={3} maxLength={32} autoComplete="username" autoFocus={mode === 'login'}/></label>
          <label className="field"><span>Password</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required minLength={8} autoComplete={mode === 'login' ? 'current-password' : 'new-password'}/></label>
          <InlineError message={error}/>
          <button className="primary-button primary-button--wide" type="submit" disabled={busy}>{busy ? 'Please wait…' : mode === 'login' ? <>Sign in <ArrowRight size={15}/></> : <>Join Overroot <ArrowRight size={15}/></>}</button>
        </form>
        <div className="auth-switch">{mode === 'login' ? <>Have an invitation? <Link to="/register">Create an account</Link></> : <>Already a member? <Link to="/login">Sign in</Link></>}</div>
      </section>
    </main>
    <footer className="auth-footer"><span>Invite-only · Self-hosted</span><span>Overroot is independent and unaffiliated with other LaTeX services.</span></footer>
  </div>;
}
