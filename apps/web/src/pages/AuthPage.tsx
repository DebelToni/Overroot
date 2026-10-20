import { ArrowRight } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { InlineError } from '../components/Feedback';
import { Brand } from '../components/Brand';
import { ThemeControl } from '../components/ThemeControl';
import { useTheme } from '../hooks/useTheme';
import { useSession } from '../lib/session';

export function AuthPage({ mode }: { mode: 'login' | 'register' }) {
  const { api } = useSession();
  const theme = useTheme();
  const [params] = useSearchParams();
  const reason = params.get('authError');
  const error = reason === 'invalid_attempt' ? 'This sign-in attempt expired or is invalid. Start a fresh sign-in to continue.'
    : reason === 'accounts_unavailable' ? 'Shared accounts could not complete sign-in. Please try again.' : null;
  return <div className="auth-shell">
    <header className="auth-head"><Brand/><ThemeControl value={theme.preference} onChange={theme.setPreference}/></header>
    <div className="accent-line"/>
    <main className="auth-main">
      <section className="auth-story"><h1>Collaborative LaTeX</h1><p>Write, compile, and share LaTeX projects with people and agents.</p></section>
      <section className="auth-panel" aria-labelledby="auth-title">
        <h2 id="auth-title">{mode === 'register' ? 'Create an account' : 'Sign in'}</h2>
        <p>Use your shared Space account. New accounts require administrator approval.</p>
        <InlineError message={error}/>
        <a className="primary-button primary-button--wide" href={api.url('/api/v1/auth/start')}>{error ? 'Start fresh sign-in' : 'Continue to shared accounts'} <ArrowRight size={15}/></a>
      </section>
    </main>
  </div>;
}
