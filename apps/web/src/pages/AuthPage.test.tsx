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
