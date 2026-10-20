import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from './App';
import { ApiError } from './lib/api';

const harness = vi.hoisted(() => ({
  api: { me: vi.fn(), url: (path: string) => `https://overroot.toni.foo${path}` },
  clearSession: vi.fn(), setUser: vi.fn()
}));
vi.mock('./lib/api-base', () => ({ resolveApiBase: async () => 'https://overroot.toni.foo' }));
vi.mock('./lib/session', () => ({
  SessionProvider: ({ children }: { children: ReactNode }) => children,
  useSession: () => ({ ...harness, user: null })
}));
vi.mock('./hooks/useTheme', () => ({ useTheme: () => ({ preference: 'system', setPreference: vi.fn() }) }));
beforeEach(() => { harness.api.me.mockRejectedValue(new ApiError(401, 'authentication_required', 'Sign in')); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="route">{location.pathname}</output>;
}
it('keeps an unauthenticated project deep link through login navigation and the central handoff link', async () => {
  render(<MemoryRouter initialEntries={['/project/opaque?file=sections%2Fintro.tex#source-line-12']}><App/><LocationProbe/></MemoryRouter>);
  const link = await screen.findByRole('link', { name: /Continue to shared accounts/ });
  expect(screen.getByTestId('route')).toHaveTextContent('/login');
  const url = new URL(link.getAttribute('href')!);
  expect(url.pathname).toBe('/api/v1/auth/start');
  expect(url.searchParams.get('returnTo')).toBe('/#/project/opaque?file=sections%2Fintro.tex#source-line-12');
});
it('leaves the normal root sign-in link unchanged', async () => {
  render(<MemoryRouter initialEntries={['/']}><App/></MemoryRouter>);
  expect(await screen.findByRole('link', { name: /Continue to shared accounts/ })).toHaveAttribute('href', 'https://overroot.toni.foo/api/v1/auth/start');
});
