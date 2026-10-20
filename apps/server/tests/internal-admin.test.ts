import { request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import { INTERNAL_USERS_PATH } from '../src/internal-admin.js';
import { buildApp, humanHeaders, login, MockIdentity, seedUser } from './helpers.js';

const key = 'internal-directory-test-only-key-32-characters';
let dir: string;
let built: Awaited<ReturnType<typeof buildApp>>;
let provider: MockIdentity;
let ownerToken: string;
let memberToken: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'overroot-private-admin-'));
  vi.stubEnv('OVERROOT_IDENTITY_CLIENT_SECRET', key);
  config.fakeCompiler = true;
  provider = new MockIdentity();
  built = await buildApp({ databasePath: join(dir, 'db.sqlite3'), identityProvider: provider, logger: false });
  const owner = seedUser(built.context.db, 'existing-owner', true);
  const member = seedUser(built.context.db, 'ordinary-member', false);
  ownerToken = login(built.context.auth, owner, provider);
  memberToken = login(built.context.auth, member, provider);
  built.context.projects.createProject(owner.id, 'PRIVATE_PROJECT_MUST_NOT_APPEAR');
  built.context.db.run("UPDATE users SET password_hash = 'PASSWORD_HASH_MUST_NOT_APPEAR'");
});
afterEach(async () => { await built.app.close(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });
it('removes public account-admin APIs even for the existing owner and a correct service key', async () => {
  for (const path of ['/api/v1/admin/users', '/api/v1/admin/invites']) {
    const response = await built.app.inject({ url: path, headers: { ...humanHeaders(ownerToken), 'x-accounts-client-key': key } });
    expect(response.statusCode).toBe(404);
  }
  const response = await built.app.inject({ url: INTERNAL_USERS_PATH, headers: { ...humanHeaders(ownerToken), 'x-accounts-client-key': key } });
  expect(response.statusCode).toBe(403);
});
it('redirects the local admin affordance only to issuer /admin; central owner policy remains there', async () => {
  const response = await built.app.inject({ url: '/api/v1/auth/admin', headers: humanHeaders(ownerToken) });
  expect(response.statusCode).toBe(302);
  expect(response.headers.location).toBe(`${provider.origin}/admin`);
  expect(response.body).not.toContain('private');
  expect((await built.app.inject({ url: '/api/v1/auth/admin', headers: humanHeaders(memberToken) })).statusCode).toBe(403);
  expect((await built.app.inject({ url: '/api/v1/auth/admin' })).statusCode).toBe(401);
});
it.each(['127.0.0.1', '127.0.0.2', '::1', '::ffff:127.0.0.1'])('allows only explicit client-key access from raw loopback %s without public sessions', async (remoteAddress) => {
  provider.outage = true;
  const response = await built.app.inject({ url: INTERNAL_USERS_PATH, remoteAddress, headers: { host: 'overroot.admin.internal', 'x-accounts-client-key': key } });
  expect(response.statusCode).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  const users = response.json().users;
  expect(users).toHaveLength(2);
  expect(Object.keys(users[0]).sort()).toEqual(['id', 'subject', 'username', 'displayName', 'isAdmin', 'createdAt'].sort());
  expect(users.find((u: { username: string }) => u.username === 'existing-owner').isAdmin).toBe(true);
  for (const user of users) expect(user.subject).toBe(user.id);
  expect(provider.calls).toBe(0);
  for (const secret of ['PASSWORD_HASH_MUST_NOT_APPEAR', 'PRIVATE_PROJECT_MUST_NOT_APPEAR', ownerToken, memberToken, ...provider.grants.keys()]) expect(response.body).not.toContain(secret);
});
it.each([
  { remoteAddress: '198.51.100.4', host: 'overroot.admin.internal', key },
  { remoteAddress: '127.0.0.1', host: 'overroot.admin.internal', key: '' },
  { remoteAddress: '127.0.0.1', host: 'overroot.admin.internal', key: 'incorrect-key' },
  { remoteAddress: '127.0.0.1', host: 'overroot.admin.internal:4317', key },
  { remoteAddress: '127.0.0.1', host: 'evil.test', key }
])('denies wrong raw peer/Host/key despite forged forwarded headers: %j', async (input) => {
  const response = await built.app.inject({ url: INTERNAL_USERS_PATH, remoteAddress: input.remoteAddress, headers: {
    host: input.host, 'x-accounts-client-key': input.key, 'x-forwarded-for': '127.0.0.1', 'x-forwarded-host': 'overroot.admin.internal', cookie: humanHeaders(ownerToken).cookie
  } });
  expect(response.statusCode).toBe(403);
  expect(response.json()).not.toHaveProperty('users');
});
it('fails closed when internal client configuration is absent', async () => {
  vi.stubEnv('OVERROOT_IDENTITY_CLIENT_SECRET', '');
  expect((await built.app.inject({ url: INTERNAL_USERS_PATH, headers: { host: 'overroot.admin.internal', 'x-accounts-client-key': key } })).statusCode).toBe(403);
});
it('does not allow the internal hostname to reach other API methods/routes', async () => {
  const headers = { host: 'overroot.admin.internal', 'x-accounts-client-key': key };
  expect((await built.app.inject({ url: '/api/v1/status', headers })).statusCode).toBe(403);
  expect((await built.app.inject({ method: 'POST', url: INTERNAL_USERS_PATH, headers })).statusCode).toBe(403);
  expect((await built.app.inject({ method: 'OPTIONS', url: '/api/v1/status', headers: { ...headers, origin: config.publicUrl, 'access-control-request-method': 'GET' } })).statusCode).toBe(403);
});
it('proves the private directory boundary over a real loopback HTTP socket, including duplicate Host rejection', async () => {
  await built.app.listen({ host: '127.0.0.1', port: 0 });
  const port = (built.app.server.address() as AddressInfo).port;
  function get(headers: string[], path = INTERNAL_USERS_PATH) {
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = httpRequest({ hostname: '127.0.0.1', port, path, headers }, (response) => {
        let body = '';
        response.setEncoding('utf8'); response.on('data', (part: string) => { body += part; });
        response.on('end', () => resolve({ status: response.statusCode!, body }));
      });
      request.on('error', reject); request.end();
    });
  }
  expect((await get(['Host', 'overroot.admin.internal', 'X-Accounts-Client-Key', key])).status).toBe(200);
  expect((await get(['Host', new URL(config.publicUrl).host, 'X-Accounts-Client-Key', key])).status).toBe(403);
  expect([403, 404]).toContain((await get(['Host', new URL(config.publicUrl).host, 'X-Accounts-Client-Key', key], 'http://overroot.admin.internal' + INTERNAL_USERS_PATH)).status);
  for (const headers of [
    ['Host', 'overroot.admin.internal', 'Host', new URL(config.publicUrl).host, 'X-Accounts-Client-Key', key],
    ['Host', 'overroot.admin.internal', 'X-Accounts-Client-Key', key, 'X-Accounts-Client-Key', key]
  ]) expect([400, 403]).toContain((await get(headers)).status);
});
