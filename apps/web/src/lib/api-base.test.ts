import { describe, expect, it, vi } from 'vitest';
import { resolveApiBase, ServerOfflineError } from './api-base';

const origin = 'https://overroot.toni.foo';

describe('resolveApiBase', () => {
  it.each([
    [{ dev: false, origin }, origin],
    [{ dev: true, origin }, 'http://127.0.0.1:4317'],
    [{ dev: false, origin, envBase: ' http://127.0.0.1:4317/ ' }, 'http://127.0.0.1:4317'],
    [{ dev: true, origin, envBase: 'https://api.example.com/' }, 'https://api.example.com'],
  ])('selects and verifies the API base for %j', async (options, base) => {
    const fetcher = vi.fn().mockResolvedValue(new Response('{}'));
    await expect(resolveApiBase({ ...options, fetcher })).resolves.toBe(base);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(`${base}/api/v1/status`, {
      cache: 'no-store', signal: expect.any(AbortSignal),
    });
  });

  it('reports unhealthy status and permits a fresh retry', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('', { status: 503 })).mockResolvedValueOnce(new Response('{}'));
    await expect(resolveApiBase({ dev: false, origin, fetcher })).rejects.toBeInstanceOf(ServerOfflineError);
    await expect(resolveApiBase({ dev: false, origin, fetcher })).resolves.toBe(origin);
  });

  it('reports network failures', async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(resolveApiBase({ dev: false, origin, fetcher })).rejects.toBeInstanceOf(ServerOfflineError);
  });
});
