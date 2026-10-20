import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import { sha256 } from '../src/security.js';
import { buildApp, MockIdentity, login, seedUser } from './helpers.js';

let dir: string;
let built: Awaited<ReturnType<typeof buildApp>>;
let provider: MockIdentity;
let client: WebSocket | undefined;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'overroot-socket-revoke-'));
  config.fakeCompiler = true;
  provider = new MockIdentity();
  built = await buildApp({ databasePath: join(dir, 'state.sqlite3'), identityProvider: provider, logger: false });
  await built.app.listen({ host: '127.0.0.1', port: 0 });
});
afterEach(async () => { client?.terminate(); client = undefined; await built.app.close(); vi.useRealTimers(); await rm(dir, { recursive: true, force: true }); });
function ticket() {
  const { context } = built;
  const user = seedUser(context.db, 'human');
  const sessionHash = sha256(login(context.auth, user, provider));
  const project = context.projects.createProject(user.id, 'Private');
  const grant = context.tickets.create({ channel: 'events', projectId: project.id, projectHash: project.public_hash, actor: { type: 'user', id: user.id, name: 'human' }, sessionHash });
  const port = (built.app.server.address() as AddressInfo).port;
  return { sessionHash, url: `ws://127.0.0.1:${port}/ws/projects/${project.public_hash}/events?ticket=${grant.token}` };
}
function connect(url: string) {
  client = new WebSocket(url, { headers: { host: new URL(config.publicUrl).host, origin: config.publicUrl } });
  return client;
}
it.each(['revoked', 'outage', 'logged-out', 'membership-removed', 'no-use'] as const)('revalidates a ticket before upgrade: %s', async (mode) => {
  const grant = ticket();
  if (mode === 'no-use') for (const grant of provider.grants.values()) grant.permissions = [];
  if (mode === 'revoked') provider.grants.clear();
  if (mode === 'outage') provider.outage = true;
  if (mode === 'membership-removed') built.context.db.run('DELETE FROM project_members');
  if (mode === 'logged-out') built.context.db.run('DELETE FROM sessions WHERE token_hash = ?', grant.sessionHash);
  const socket = connect(grant.url);
  const response = await new Promise<number>((resolve, reject) => {
    socket.on('unexpected-response', (_request, reply) => { reply.resume(); resolve(reply.statusCode!); });
    socket.on('open', () => reject(new Error('Unauthorized upgrade accepted')));
    socket.on('error', reject);
  });
  expect(response).toBe(mode === 'outage' ? 503 : 401);
});
it.each([['revoked', 1008], ['no-use', 1008], ['outage', 1013]] as const)('closes a live human socket on %s within the bounded interval', async (mode, code) => {
  const grant = ticket();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const socket = connect(grant.url);
  await once(socket, 'open');
  const closed = once(socket, 'close');
  if (mode === 'revoked') provider.grants.clear();
  else if (mode === 'no-use') for (const grant of provider.grants.values()) grant.permissions = [];
  else provider.outage = true;
  await vi.advanceTimersByTimeAsync(10_000);
  expect((await closed)[0]).toBe(code);
  const count = provider.calls;
  await built.app.close();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(provider.calls).toBe(count);
});

it('drains in-flight introspection before database teardown in preClose', async () => {
  const grant = ticket();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const socket = connect(grant.url);
  await once(socket, 'open');
  let finish!: (value: { active: false }) => void;
  vi.spyOn(provider, 'introspect').mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await vi.advanceTimersByTimeAsync(10_000);
  let stopped = false;
  const closing = built.app.close().then(() => { stopped = true; });
  await Promise.resolve();
  expect(stopped).toBe(false);
  expect(built.context.db.get('SELECT 1 AS alive')).toBeTruthy();
  finish({ active: false });
  await closing;
  expect(stopped).toBe(true);
});

it('keeps an admitted socket and local content permissions unchanged after a registered service role change', async () => {
  const grant = ticket();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const socket = connect(grant.url);
  await once(socket, 'open');
  const before = provider.calls;
  for (const grant of provider.grants.values()) {
    grant.role = 'registered-role';
    grant.permissions = ['use', 'registered:feature'];
  }
  await vi.advanceTimersByTimeAsync(10_000);
  expect(provider.calls).toBeGreaterThan(before);
  expect(socket.readyState).toBe(WebSocket.OPEN);
});
