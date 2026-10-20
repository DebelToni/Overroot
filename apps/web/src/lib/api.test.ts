import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError } from './api';

afterEach(() => vi.unstubAllGlobals());

describe('ApiClient', () => {
  it('sends host-only cookies and a JSON body without a bearer token', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ project: { hash: 'prj_1' } }), { status: 201, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetcher);
    const api = new ApiClient('https://example.test');
    await api.createProject('Paper', 'article');
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://example.test/api/v1/projects');
    const headers = init.headers as Headers;
    expect(headers.has('authorization')).toBe(false);
    expect(init.credentials).toBe('include');
    expect(headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ name: 'Paper', template: 'article' });
  });

  it('clears the session on 401 and exposes the structured server error', async () => {
    const unauthorized = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'invalid_credentials', message: 'No access' } }), { status: 401 })));
    const api = new ApiClient('https://example.test', unauthorized);
    const error = await api.me().catch((reason) => reason as ApiError);
    expect(unauthorized).toHaveBeenCalledOnce();
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 401, code: 'invalid_credentials', message: 'No access' });
  });
});
