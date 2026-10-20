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

it('passes a safe project target including query and fragment to auth/start', () => {
  const returnTo = '/#/project/opaque?file=sections%2Fintro.tex#source-line-12';
  render(<MemoryRouter initialEntries={[{ pathname: '/login', state: { returnTo } }]}><AuthPage mode="login"/></MemoryRouter>);
  const href = screen.getByRole('link', { name: /Continue to shared accounts/ }).getAttribute('href')!;
  const url = new URL(href);
  expect(url.origin).toBe('https://overroot.toni.foo');
  expect(url.pathname).toBe('/api/v1/auth/start');
  expect(url.searchParams.get('returnTo')).toBe(returnTo);
});
it.each([
  'https://evil.test/project/stolen', '//evil.test/project/stolen', '/\\evil.test',
  '/api/v1/auth/callback', '/#/project/opaque\r\nLocation:evil', '/#/project/\\evil',
  `/#/project/${'x'.repeat(2048)}`, null, 123, { pathname: '/project/opaque' }, '/#/'
])('keeps the default sign-in link for an unsafe or default target: %j', (returnTo) => {
  render(<MemoryRouter initialEntries={[{ pathname: '/login', state: { returnTo } }]}><AuthPage mode="login"/></MemoryRouter>);
  expect(screen.getByRole('link', { name: /Continue to shared accounts/ })).toHaveAttribute('href', 'https://overroot.toni.foo/api/v1/auth/start');
});
