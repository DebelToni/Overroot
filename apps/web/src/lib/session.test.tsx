import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionProvider, useSession } from './session';

function Probe() {
  const { api } = useSession();
  return <button type="button" onClick={() => { void api.me(); }}>Check cookie session</button>;
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });
it('discards old localStorage tokens and uses cookie transport without a bearer header', async () => {
  localStorage.setItem('overroot.session', 'old-human-bearer');
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ user: null })));
  vi.stubGlobal('fetch', fetcher);
  render(<SessionProvider apiBase="https://overroot.toni.foo" onNetworkError={vi.fn()}><Probe/></SessionProvider>);
  expect(localStorage.getItem('overroot.session')).toBeNull();
  screen.getByRole('button').click();
  await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  expect(fetcher.mock.calls[0]![1].credentials).toBe('include');
  expect(fetcher.mock.calls[0]![1].headers.has('Authorization')).toBe(false);
});
