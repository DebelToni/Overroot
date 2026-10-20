import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AuthPage } from './AuthPage';
vi.mock('../lib/session', () => ({ useSession: () => ({ api: { url: (path: string) => `https://overroot.toni.foo${path}` } }) }));
vi.mock('../hooks/useTheme', () => ({ useTheme: () => ({ preference: 'system', setPreference: vi.fn() }) }));
afterEach(cleanup);
it.each(['login', 'register'] as const)('%s directs people to central sign-in without collecting passwords', (mode) => {
  const { container } = render(<AuthPage mode={mode}/>);
  expect(screen.getByRole('link', { name: /Continue to shared accounts/ })).toHaveAttribute('href', 'https://overroot.toni.foo/api/v1/auth/start');
  expect(container.querySelector('input')).toBeNull();
  expect(screen.getByText(/administrator approval/)).toBeInTheDocument();
});
