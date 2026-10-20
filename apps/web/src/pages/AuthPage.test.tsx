import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { AuthPage } from './AuthPage';
vi.mock('../lib/session', () => ({ useSession: () => ({ api: { url: (path: string) => `https://overroot.toni.foo${path}` } }) }));
vi.mock('../hooks/useTheme', () => ({ useTheme: () => ({ preference: 'system', setPreference: vi.fn() }) }));
afterEach(cleanup);
it.each(['login', 'register'] as const)('%s directs people to central sign-in without collecting passwords', (mode) => {
  const { container } = render(<MemoryRouter><AuthPage mode={mode}/></MemoryRouter>);
  expect(screen.getByRole('link', { name: /Continue to shared accounts/ })).toHaveAttribute('href', 'https://overroot.toni.foo/api/v1/auth/start');
  expect(container.querySelector('input')).toBeNull();
  expect(screen.getByText(/administrator approval/)).toBeInTheDocument();
});

it.each([
  ['invalid_attempt', 'This sign-in attempt expired or is invalid. Start a fresh sign-in to continue.'],
  ['accounts_unavailable', 'Shared accounts could not complete sign-in. Please try again.']
])('shows %s recovery with an explicit fresh-sign-in action', (reason, message) => {
  const { container } = render(<MemoryRouter initialEntries={[`/login?authError=${reason}`]}><AuthPage mode="login"/></MemoryRouter>);
  expect(screen.getByRole('alert')).toHaveTextContent(message);
  expect(screen.getByRole('link', { name: /Start fresh sign-in/ })).toHaveAttribute('href', 'https://overroot.toni.foo/api/v1/auth/start');
  expect(container.querySelector('input')).toBeNull();
});
it('never reflects unrecognized callback query text', () => {
  render(<MemoryRouter initialEntries={['/login?authError=untrusted-text&code=private-code&state=private-state']}><AuthPage mode="login"/></MemoryRouter>);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByText(/private-code|private-state|untrusted-text/)).toBeNull();
  expect(screen.getByRole('link', { name: /Continue to shared accounts/ })).toHaveAttribute('href', 'https://overroot.toni.foo/api/v1/auth/start');
});
