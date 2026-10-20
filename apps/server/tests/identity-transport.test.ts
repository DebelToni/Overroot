import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { AccountsProvider } from '../src/identity.js';

const secret = 'test-only-confidential-secret-32-characters';
const origin = 'https://accounts.example.test:8443';
const callback = 'https://overroot.example.test/api/v1/auth/callback';
const admitted = () => ({
  session_id: 'fixture-grant', expires_at: Math.floor(Date.now() / 1000) + 3600,
  service_id: 'overroot', role: 'member', permissions: ['use'],
  user: { id: 'immutable-subject', email: 'member@example.test', nickname: 'Member', approved: true }
});
let server: Server | undefined;
afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    server = undefined;
  }
  vi.unstubAllEnvs();
});
async function provider(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  server = createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  vi.stubEnv('OVERROOT_IDENTITY_ORIGIN', origin);
  vi.stubEnv('OVERROOT_IDENTITY_BASE_URL', `http://127.0.0.1:${port}`);
  vi.stubEnv('OVERROOT_IDENTITY_CLIENT_SECRET', secret);
  return new AccountsProvider('https://overroot.example.test');
}
it('captures real HTTP Host, client key, methods and JSON bindings for all backchannel endpoints', async () => {
  const captures: Array<{ path: string; method: string; headers: IncomingMessage['headers']; body: unknown }> = [];
  const client = await provider((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      captures.push({ path: request.url!, method: request.method!, headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString()) });
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(request.url!.endsWith('/token') ? admitted() : request.url!.endsWith('/introspect') ? { active: true, ...admitted() } : { ok: true }));
    });
  });
  expect(await client.exchange('single-use-code', 'pkce-verifier')).toMatchObject({ service_id: 'overroot', permissions: ['use'] });
  expect(await client.introspect('fixture-grant')).toMatchObject({ active: true, role: 'member' });
  await client.revoke('fixture-grant');
  expect(captures.map((c) => [c.method, c.path, c.body])).toEqual([
    ['POST', '/api/accounts/token', { client_id: 'overroot', grant_type: 'authorization_code', redirect_uri: callback, code: 'single-use-code', code_verifier: 'pkce-verifier' }],
    ['POST', '/api/accounts/introspect', { client_id: 'overroot', session_id: 'fixture-grant' }],
    ['POST', '/api/accounts/revoke', { client_id: 'overroot', session_id: 'fixture-grant' }]
  ]);
  for (const capture of captures) {
    expect(capture.headers.host).toBe('accounts.example.test:8443');
    expect(capture.headers['x-accounts-client-key']).toBe(secret);
    expect(capture.headers['content-type']).toBe('application/json');
    expect(capture.headers['content-length']).toBe(String(Buffer.byteLength(JSON.stringify(capture.body))));
    expect(capture.headers.cookie).toBeUndefined();
    expect(capture.headers.authorization).toBeUndefined();
    expect(capture.headers.origin).toBeUndefined();
  }
});
it.each([301, 302, 307, 400, 401, 403, 500])('rejects HTTP %i without following redirects or forwarding secrets', async (status) => {
  const paths: string[] = [];
  const client = await provider((request, response) => {
    paths.push(request.url!); response.writeHead(status, { Location: '/must-not-follow' }); response.end('{}');
  });
  await expect(client.exchange('code', 'verifier')).rejects.toMatchObject({ statusCode: 503 });
  expect(paths).toEqual(['/api/accounts/token']);
});
it.each(['headers', 'body'] as const)('enforces the absolute 3s timeout on stalled %s over real HTTP', async (phase) => {
  const client = await provider((_request, response) => {
    if (phase === 'body') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.write('{"active":'); }
  });
  const started = performance.now();
  await expect(client.introspect('grant')).rejects.toMatchObject({ statusCode: 503 });
  const elapsed = performance.now() - started;
  expect(elapsed).toBeGreaterThanOrEqual(2700);
  expect(elapsed).toBeLessThan(4500);
}, 10_000);
it.each(['oversize', 'oversize-headers', 'invalid-json', 'disconnect'] as const)('bounds and rejects %s responses over real HTTP', async (kind) => {
  const client = await provider((request, response) => {
    if (kind === 'disconnect') return request.socket.destroy();
    if (kind === 'oversize-headers') response.setHeader('X-Oversize', 'x'.repeat(16_385));
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(kind === 'oversize' ? 'x'.repeat(16_385) : '{invalid');
  });
  await expect(client.introspect('grant')).rejects.toMatchObject({ statusCode: 503 });
});
it.each([
  { service_id: 'space' }, { service_id: undefined }, { role: undefined }, { role: '' }, { role: 'x'.repeat(65) },
  { permissions: undefined }, { permissions: ['x'.repeat(65)] }, { permissions: Array(65).fill('use') },
  { user: { ...admitted().user, approved: false } }, { user: { ...admitted().user, nickname: 'x'.repeat(257) } }
])('rejects malformed or wrong-service policy fields: %j', async (fields) => {
  const client = await provider((_request, response) => response.end(JSON.stringify({ active: true, ...admitted(), ...fields })));
  await expect(client.exchange('code', 'verifier')).rejects.toMatchObject({ statusCode: 503 });
  // Introspection has the identical active-grant schema, not a looser policy path.
  await expect(client.introspect('grant')).rejects.toMatchObject({ statusCode: 503 });
});
it('accepts registered service-specific role/permission fields without inferring content authority', async () => {
  const client = await provider((_request, response) => response.end(JSON.stringify({ active: true, ...admitted(), role: 'registered-role', permissions: ['use', 'registered:permission'] })));
  expect(await client.introspect('grant')).toMatchObject({ active: true, role: 'registered-role', permissions: ['use', 'registered:permission'] });
});
it('rejects expired token responses and accepts explicit inactive introspection', async () => {
  const client = await provider((request, response) => response.end(JSON.stringify(request.url!.endsWith('/token') ? { ...admitted(), expires_at: 1 } : { active: false })));
  await expect(client.exchange('expired', 'verifier')).rejects.toMatchObject({ statusCode: 503 });
  expect(await client.introspect('revoked')).toEqual({ active: false });
});
it.each([0, 1, 16, 31])('fails closed with a %i-character configured client key', async (length) => {
  await provider((_request, response) => response.end('{}'));
  vi.stubEnv('OVERROOT_IDENTITY_CLIENT_SECRET', 'x'.repeat(length));
  expect(() => new AccountsProvider('https://overroot.example.test')).toThrow();
});
it('accepts the 32-character minimum client key', async () => {
  await provider((_request, response) => response.end('{}'));
  vi.stubEnv('OVERROOT_IDENTITY_CLIENT_SECRET', 'x'.repeat(32));
  expect(() => new AccountsProvider('https://overroot.example.test')).not.toThrow();
});

it('requires an explicit backchannel instead of silently using the public WAN issuer', async () => {
  await provider((_request, response) => response.end('{}'));
  vi.stubEnv('OVERROOT_IDENTITY_BASE_URL', '');
  expect(() => new AccountsProvider('https://overroot.example.test')).toThrow('configuration is required');
});
