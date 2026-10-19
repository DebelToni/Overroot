import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthPage } from './AuthPage';

const harness = vi.hoisted(() => ({
  api: { request: vi.fn(), login: vi.fn(), register: vi.fn() },
  setSession: vi.fn()
}));
vi.mock('../lib/session', () => ({ useSession: () => ({ api: harness.api, token: null, setSession: harness.setSession }) }));
vi.mock('../hooks/useTheme', () => ({ useTheme: () => ({ preference: 'light', setPreference: vi.fn() }) }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.resetAllMocks();
  harness.api.request.mockResolvedValue({ setupRequired: false });
});
afterEach(cleanup);

describe('authentication progress', () => {
  it('ignores a late sign-in result after switching to registration', async () => {
    const pending = deferred<{ token: string; user: { username: string } }>();
    harness.api.login.mockReturnValueOnce(pending.promise);
    render(<MemoryRouter initialEntries={['/login']}><Routes><Route path="/login" element={<AuthPage mode="login"/>}/><Route path="/register" element={<AuthPage mode="register"/>}/><Route path="/" element={<div>Project dashboard</div>}/></Routes></MemoryRouter>);
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'writer' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'test-password' } });
    fireEvent.submit(screen.getByLabelText('Password').closest('form')!);
    fireEvent.click(screen.getByRole('link', { name: 'Create an account' }));
    expect(screen.getByRole('button', { name: 'Join Overroot' })).toBeEnabled();
    await act(async () => { pending.resolve({ token: 'stale-token', user: { username: 'writer' } }); });
    expect(harness.setSession).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Create an account' })).toBeInTheDocument();
    expect(screen.queryByText('Project dashboard')).not.toBeInTheDocument();
  });

  it('keeps current registration progress when the previous sign-in fails late', async () => {
    const login = deferred<{ token: string; user: { username: string } }>();
    const register = deferred<{ token: string; user: { username: string } }>();
    harness.api.login.mockReturnValueOnce(login.promise);
    harness.api.register.mockReturnValueOnce(register.promise);
    render(<MemoryRouter initialEntries={['/login']}><Routes><Route path="/login" element={<AuthPage mode="login"/>}/><Route path="/register" element={<AuthPage mode="register"/>}/><Route path="/" element={<div>Project dashboard</div>}/></Routes></MemoryRouter>);
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'writer' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'test-password' } });
    fireEvent.submit(screen.getByLabelText('Password').closest('form')!);
    fireEvent.click(screen.getByRole('link', { name: 'Create an account' }));
    fireEvent.change(screen.getByLabelText('Invitation'), { target: { value: 'invitation' } });
    fireEvent.submit(screen.getByLabelText('Password').closest('form')!);
    await act(async () => { login.reject(new Error('Old login rejected')); });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Creating account…' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Creating account…');
    const session = { token: 'current-token', user: { username: 'writer' } };
    await act(async () => { register.resolve(session); });
    expect(harness.setSession).toHaveBeenCalledExactlyOnceWith(session.token, session.user);
    expect(screen.getByText('Project dashboard')).toBeInTheDocument();
  });

  it.each(['login', 'register'] as const)('keeps %s progress tied to the request and recovers after failure', async (mode) => {
    const pending = deferred<{ token: string; user: { username: string } }>();
    harness.api[mode].mockReturnValue(pending.promise);
    render(<MemoryRouter initialEntries={['/auth']}><Routes><Route path="/auth" element={<AuthPage mode={mode}/>}/><Route path="/" element={<div>Project dashboard</div>}/></Routes></MemoryRouter>);
    if (mode === 'register') fireEvent.change(screen.getByLabelText('Invitation'), { target: { value: 'invitation' } });
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'writer' } });
    const password = screen.getByLabelText('Password');
    fireEvent.change(password, { target: { value: 'test-password' } });
    const form = password.closest('form')!;
    fireEvent.submit(form);
    const progress = mode === 'login' ? 'Signing in…' : 'Creating account…';
    const button = screen.getByRole('button', { name: progress });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    // Chromium may defer descendant text while aria-busy; keep the name explicit.
    expect(button).toHaveAttribute('aria-label', progress);
    expect(button).toHaveAccessibleName(progress);
    expect(screen.getByRole('status')).toHaveTextContent(progress);
    expect(screen.getByRole('status').querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    fireEvent.submit(form);
    expect(harness.api[mode]).toHaveBeenCalledTimes(1);

    await act(async () => { pending.reject(new Error('Please check your credentials')); });
    expect(screen.getByRole('alert')).toHaveTextContent('Please check your credentials');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    const retryButton = screen.getByRole('button', { name: mode === 'login' ? 'Sign in' : 'Join Overroot' });
    expect(retryButton).toBeEnabled();
    expect(retryButton).not.toHaveAttribute('aria-label');

    const session = { token: 'local-test-token', user: { username: 'writer' } };
    harness.api[mode].mockResolvedValueOnce(session);
    fireEvent.submit(form);
    await screen.findByText('Project dashboard');
    expect(harness.setSession).toHaveBeenCalledWith(session.token, session.user);
    expect(harness.api[mode]).toHaveBeenCalledTimes(2);
  });
});
