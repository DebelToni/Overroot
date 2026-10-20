import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp as productionBuild } from '../src/app.js';
import { AccountsProvider, unavailable } from '../src/identity.js';
import { config } from '../src/config.js';
import { sha256 } from '../src/security.js';
import { localReturnPath } from '../src/routes/auth-routes.js';
import { buildApp, humanHeaders, login, MockIdentity, seedUser } from './helpers.js';

let dir: string;
let built: Awaited<ReturnType<typeof buildApp>>;
let provider: MockIdentity;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'overroot-identity-'));
  config.fakeCompiler = true;
  provider = new MockIdentity();
  built = await buildApp({ databasePath: join(dir, 'test.sqlite3'), identityProvider: provider, logger: false });
});
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); await built.app.close(); await rm(dir, { recursive: true, force: true }); });

async function start(returnTo = '/#/') {
  const response = await built.app.inject({ url: `/api/v1/auth/start?returnTo=${encodeURIComponent(returnTo)}` });
  expect(response.statusCode).toBe(302);
  return { url: new URL(response.headers.location!), cookie: response.cookies[0]!.name + '=' + response.cookies[0]!.value };
}
function callback(state: string, cookie: string, code = 'single-use-code') {
  return built.app.inject({ url: `/api/v1/auth/callback?state=${state}&code=${code}`, headers: { cookie } });
}
function expectRecovery(response: Awaited<ReturnType<typeof callback>>) {
  expect(response.statusCode).toBe(302);
  expect(response.headers.location).toBe('/#/login?authError=invalid_attempt');
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.headers['set-cookie']).toContain('Max-Age=0');
}
function exchangeFor(challenge: string, subject = 'space-existing') {
  const grant = provider.grant(subject, 'Same nickname');
  let used = false;
  vi.spyOn(provider, 'exchange').mockImplementation(async (code, verifier) => {
    if (code !== 'single-use-code' || used || createHash('sha256').update(verifier).digest('base64url') !== challenge) throw new Error('Invalid code or PKCE');
    used = true;
    return grant;
  });
  return grant;
}

describe('central sign-in consumer', () => {
  it('uses PKCE, fixed redirect, single-use browser-bound state, and host-only cookies', async () => {
    const attempt = await start('/#/project/opaque?file=sections%2Fintro.tex#source-line-12');
    expect(attempt.url.origin).toBe(provider.origin);
    expect(attempt.url.searchParams.get('redirect_uri')).toBe(provider.callback);
    expect(attempt.url.searchParams.get('code_challenge_method')).toBe('S256');
    const grant = exchangeFor(attempt.url.searchParams.get('code_challenge')!);
    const state = attempt.url.searchParams.get('state')!;
    expectRecovery(await callback(state, ''));
    expect(provider.exchange).not.toHaveBeenCalled();
    const response = await callback(state, attempt.cookie);
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/#/project/opaque?file=sections%2Fintro.tex#source-line-12');
    const cookies = response.headers['set-cookie'] as string[];
    expect(cookies.every((value) => value.includes('HttpOnly') && value.includes('Secure') && value.includes('SameSite=Lax') && !value.includes('Domain='))).toBe(true);
    expect(response.body).not.toContain('or_session_');
    expectRecovery(await callback(state, attempt.cookie));
    const session = response.cookies.find((entry) => entry.name === '__Host-overroot_session')!;
    const me = await built.app.inject({ url: '/api/v1/auth/me', headers: humanHeaders(session.value) });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.isAdmin).toBe(false);
    expect(provider.grants.has(grant.session_id)).toBe(true);
  });
  it('rejects expired and mismatched state without exchanging codes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const attempt = await start();
    const exchange = vi.spyOn(provider, 'exchange');
    expectRecovery(await callback('wrong', attempt.cookie));
    vi.setSystemTime(Date.now() + 121_000);
    expectRecovery(await callback(attempt.url.searchParams.get('state')!, attempt.cookie));
    expect(exchange).not.toHaveBeenCalled();
  });
  it.each([
    '', '?state=missing-code', '?code=missing-state',
    '?state=x&state=y&code=code', '?state=x&code=',
    `?state=${'x'.repeat(257)}&code=code`
  ])('recovers visibly from malformed callback query %s without exchanging', async (query) => {
    const exchange = vi.spyOn(provider, 'exchange');
    expectRecovery(await built.app.inject({ url: `/api/v1/auth/callback${query}` }));
    expect(exchange).not.toHaveBeenCalled();
  });
  it('permits a fresh explicit sign-in after a minutes-long approval wait', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const expired = await start();
    vi.setSystemTime(Date.now() + 180_000);
    const exchange = vi.spyOn(provider, 'exchange');
    expectRecovery(await callback(expired.url.searchParams.get('state')!, expired.cookie));
    expect(exchange).not.toHaveBeenCalled();
    const fresh = await start();
    expect(fresh.url.searchParams.get('state')).not.toBe(expired.url.searchParams.get('state'));
    exchange.mockRestore();
    exchangeFor(fresh.url.searchParams.get('code_challenge')!);
    const accepted = await callback(fresh.url.searchParams.get('state')!, fresh.cookie);
    expect(accepted.statusCode).toBe(302);
    expect(accepted.headers.location).toBe('/#/');
    expect(provider.exchange).toHaveBeenCalledOnce();
  });
  it('consumes state even when the provider rejects the code or PKCE exchange', async () => {
    const attempt = await start();
    const exchange = vi.spyOn(provider, 'exchange').mockRejectedValue(unavailable());
    const state = attempt.url.searchParams.get('state')!;
    const rejected = await callback(state, attempt.cookie, 'rejected-code');
    expect(rejected.statusCode).toBe(302);
    expect(rejected.headers.location).toBe('/#/login?authError=accounts_unavailable');
    expectRecovery(await callback(state, attempt.cookie));
    expect(exchange).toHaveBeenCalledOnce();
  });
  it('denies expired and subject-mismatched grants without transferring identity', async () => {
    const token = login(built.context.auth, seedUser(built.context.db, 'human'), provider);
    const grant = [...provider.grants.values()][0]!;
    grant.user.id = 'different-subject';
    expect((await built.app.inject({ url: '/api/v1/auth/me', headers: humanHeaders(token) })).statusCode).toBe(401);
    const freshToken = login(built.context.auth, seedUser(built.context.db, 'another'), provider);
    for (const item of provider.grants.values()) item.expires_at = 1;
    expect((await built.app.inject({ url: '/api/v1/auth/me', headers: humanHeaders(freshToken) })).statusCode).toBe(401);
  });
  it('does not accept unsafe return paths', () => {
    for (const path of ['https://evil.test', '//evil.test', '/\\evil.test', '/api/v1/auth/start', '/#/\nLocation:evil']) expect(localReturnPath(path)).toBe('/#/');
    expect(localReturnPath('/#/project/opaque')).toBe('/#/project/opaque');
  });
  it('never matches unknown identities to existing names or elevates approval', () => {
    const existing = seedUser(built.context.db, 'Same nickname', true);
    const fresh = built.context.auth.createSession(provider.grant('different-subject', 'Same nickname'));
    expect(fresh.user.id).not.toBe(existing.id);
    expect(fresh.user.isAdmin).toBe(false);
    const mapped = built.context.auth.createSession(provider.grant(existing.id, 'Renamed'));
    expect(mapped.user.id).toBe(existing.id);
    expect(mapped.user.isAdmin).toBe(true);
  });
  it('fails on unmapped legacy users and removes all local credential endpoints', async () => {
    seedUser(built.context.db, 'legacy');
    built.context.db.run('DELETE FROM external_identities');
    expect((await built.app.inject({ url: '/api/v1/auth/start' })).statusCode).toBe(503);
    for (const endpoint of ['login', 'register', 'password']) {
      const response = await built.app.inject({ method: 'POST', url: `/api/v1/auth/${endpoint}`, payload: { password: 'must-not-be-used' } });
      expect(response.statusCode).toBe(404);
    }
  });
  it('introspects every human request, preserves sessions on outages, and rejects revoked grants', async () => {
    const user = seedUser(built.context.db, 'human');
    const token = login(built.context.auth, user, provider);
    const headers = humanHeaders(token);
    for (let i = 0; i < 2; i++) expect((await built.app.inject({ url: '/api/v1/projects', headers })).statusCode).toBe(200);
    expect(provider.calls).toBe(2);
    provider.outage = true;
    expect((await built.app.inject({ url: '/api/v1/projects', headers })).statusCode).toBe(503);
    expect(built.context.db.get('SELECT token_hash FROM sessions WHERE token_hash = ?', sha256(token))).toBeTruthy();
    provider.outage = false;
    provider.grants.clear();
    expect((await built.app.inject({ url: '/api/v1/projects', headers })).statusCode).toBe(401);
  });
  it('enforces exact Host and mutation Origin; human bearer tokens are retired', async () => {
    const token = login(built.context.auth, seedUser(built.context.db, 'human'), provider);
    expect((await built.app.inject({ url: '/api/v1/auth/me', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(401);
    expect((await built.app.inject({ url: '/api/v1/auth/me', headers: { ...humanHeaders(token), host: 'accounts.toni.foo' } })).statusCode).toBe(403);
    for (const origin of ['https://space.toni.foo', 'https://evil.test', 'null', '']) expect((await built.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { ...humanHeaders(token), origin } })).statusCode).toBe(403);
  });
  it('gives agent headers precedence and keeps their scoped permissions during provider outages', async () => {
    const token = login(built.context.auth, seedUser(built.context.db, 'human'), provider);
    const created = await built.app.inject({ method: 'POST', url: '/api/v1/projects', headers: humanHeaders(token), payload: { name: 'Private', template: 'article' } });
    const hash = created.json().project.hash;
    const credential = await built.app.inject({ method: 'POST', url: `/api/v1/projects/${hash}/agents`, headers: humanHeaders(token), payload: { name: 'Agent' } });
    provider.outage = true;
    expect((await built.app.inject({ url: `/api/v1/projects/${hash}`, headers: { ...humanHeaders(token), authorization: `Bearer ${credential.json().access.password}` } })).statusCode).toBe(200);
    expect((await built.app.inject({ url: '/api/v1/auth/me', headers: { ...humanHeaders(token), authorization: 'Bearer invalid' } })).statusCode).toBe(401);
    expect((await built.app.inject({ url: '/api/v1/projects/other', headers: { authorization: `Bearer ${credential.json().access.password}` } })).statusCode).toBe(404);
  });
  it('revokes the central app grant and expires its cookie on local logout', async () => {
    const token = login(built.context.auth, seedUser(built.context.db, 'human'), provider);
    const response = await built.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: humanHeaders(token) });
    expect(response.statusCode).toBe(204);
    expect(response.headers['set-cookie']).toContain('Max-Age=0');
    expect(provider.grants.size).toBe(0);
    expect((await built.app.inject({ url: '/api/v1/auth/me', headers: humanHeaders(token) })).statusCode).toBe(401);
  });
  it('fails closed without central config before opening a database', async () => {
    vi.stubEnv('OVERROOT_IDENTITY_ORIGIN', '');
    vi.stubEnv('OVERROOT_IDENTITY_CLIENT_SECRET', '');
    await expect(productionBuild({ databasePath: join(dir, 'never.sqlite3'), logger: false })).rejects.toThrow('configuration is required');
  });
});

describe('sign-in admission', () => {
  function from(ip: string, headers: Record<string, string> = {}) {
    return built.app.inject({ url: '/api/v1/auth/start', remoteAddress: ip, headers });
  }
  it('limits one IP to 12 starts per rolling five minutes without exhausting other clients', async () => {
    for (let i = 0; i < 12; i++) expect((await from('198.51.100.1')).statusCode).toBe(302);
    for (let i = 0; i < 20; i++) {
      const denied = await from('198.51.100.1');
      expect(denied.statusCode).toBe(429);
      expect(denied.json().error.code).toBe('rate_limited');
      expect(denied.headers.location).toBeUndefined();
      expect(denied.headers['set-cookie']).toBeUndefined();
    }
    expect((await from('198.51.100.2')).statusCode).toBe(302);
  });
  it('does not reset admission when a browser replaces or completes an attempt', async () => {
    const first = await start();
    exchangeFor(first.url.searchParams.get('code_challenge')!);
    expect((await callback(first.url.searchParams.get('state')!, first.cookie)).statusCode).toBe(302);
    for (let i = 0; i < 11; i++) expect((await built.app.inject({ url: '/api/v1/auth/start', headers: { cookie: first.cookie } })).statusCode).toBe(302);
    expect((await built.app.inject({ url: '/api/v1/auth/start' })).statusCode).toBe(429);
  });
  it('expires idle IP buckets and admits fresh starts after the window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    for (let i = 0; i < 12; i++) await from('198.51.100.1');
    vi.setSystemTime(Date.now() + 299_999);
    expect((await from('198.51.100.1')).statusCode).toBe(429);
    vi.setSystemTime(Date.now() + 1);
    expect((await from('198.51.100.1')).statusCode).toBe(302);
    expect((await from('198.51.100.2')).statusCode).toBe(302);
  });
  it('does not let callers rotate a spoofed leftmost forwarded address to evade admission', async () => {
    for (let i = 0; i < 12; i++) expect((await from('127.0.0.1', { 'x-forwarded-for': `192.0.2.${i + 1}, 198.51.100.1` })).statusCode).toBe(302);
    expect((await from('127.0.0.1', { 'x-forwarded-for': '192.0.2.99, 198.51.100.1' })).statusCode).toBe(429);
    expect((await from('127.0.0.1', { 'x-forwarded-for': '192.0.2.99, 198.51.100.2' })).statusCode).toBe(302);
  });
});

describe('confidential provider backchannel', () => {
  function configured() {
    vi.stubEnv('OVERROOT_IDENTITY_ORIGIN', 'https://accounts.toni.foo');
    vi.stubEnv('OVERROOT_IDENTITY_BASE_URL', 'http://127.0.0.1:18746');
    vi.stubEnv('OVERROOT_IDENTITY_CLIENT_SECRET', 'test-only-confidential-secret-32-characters');
    return new AccountsProvider('https://overroot.toni.foo');
  }
  it.each([1, 16, 31])('rejects a configured confidential secret of %i characters', (length) => {
    configured();
    vi.stubEnv('OVERROOT_IDENTITY_CLIENT_SECRET', 'x'.repeat(length));
    expect(() => new AccountsProvider('https://overroot.toni.foo')).toThrow('at least 32 characters');
  });
  it('accepts a 32-character confidential secret', () => {
    configured();
    vi.stubEnv('OVERROOT_IDENTITY_CLIENT_SECRET', 'x'.repeat(32));
    expect(() => new AccountsProvider('https://overroot.toni.foo')).not.toThrow();
  });
  it('sends the client key, issuer Host, exact redirect, verifier, timeout, and no browser cookie', async () => {
    const client = configured();
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(provider.grant())));
    vi.stubGlobal('fetch', fetcher);
    await client.exchange('code', 'verifier');
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:18746/api/accounts/token');
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.headers).toEqual({ 'Content-Type': 'application/json', 'X-Accounts-Client-Key': 'test-only-confidential-secret-32-characters', Host: 'accounts.toni.foo' });
    expect(JSON.parse(init.body)).toEqual({ client_id: 'overroot', grant_type: 'authorization_code', code: 'code', code_verifier: 'verifier', redirect_uri: client.callback });
  });
  it('fails closed on a network timeout without clearing a local session', async () => {
    const client = configured();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('Timeout', 'TimeoutError')));
    await expect(client.introspect('grant')).rejects.toMatchObject({ statusCode: 503 });
  });
  it('rejects pending accounts and expired token exchange responses', async () => {
    const client = configured();
    const grant = provider.grant();
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify({ ...grant, user: { ...grant.user, approved: false } }))));
    await expect(client.exchange('pending-code', 'verifier')).rejects.toMatchObject({ statusCode: 503 });
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify({ ...grant, expires_at: 1 }))));
    await expect(client.exchange('expired-code', 'verifier')).rejects.toMatchObject({ statusCode: 503 });
  });
  it.each([401, 400, 500, 302])('fails closed on provider HTTP %i (wrong/reused code, PKCE/client/redirect rejection)', async (status) => {
    const client = configured();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status })));
    await expect(client.exchange('rejected-code', 'wrong-verifier')).rejects.toMatchObject({ statusCode: 503 });
  });
  it.each([{ active: true, user: { approved: false } }, {}, { active: true, expires_at: 1, user: { id: 'x', email: 'x@example.test', nickname: 'x', approved: true } }])('rejects malformed/pending or expires stale grants: %j', async (body) => {
    const client = configured();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body))));
    if ('expires_at' in body) expect((await client.introspect('grant'))).toMatchObject({ active: true, expires_at: 1 });
    else await expect(client.introspect('grant')).rejects.toMatchObject({ statusCode: 503 });
  });
});
