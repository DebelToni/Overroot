import { randomUUID } from 'node:crypto';
import { buildApp as buildProductionApp, type BuildAppOptions } from '../src/app.js';
import type { AuthService } from '../src/auth.js';
import { config } from '../src/config.js';
import { unavailable } from '../src/identity.js';
import type { IdentityGrant, IdentityProvider, Introspection } from '../src/identity.js';
import type { Database } from '../src/database.js';
import type { UserRecord } from '../src/types.js';

export class MockIdentity implements IdentityProvider {
  readonly origin = 'https://accounts.toni.foo';
  get callback() { return `${config.publicUrl}/api/v1/auth/callback`; }
  readonly grants = new Map<string, IdentityGrant>();
  readonly codes = new Map<string, { grant: IdentityGrant; verifier: string }>();
  outage = false;
  calls = 0;
  grant(subject: string = randomUUID(), nickname = 'Member'): IdentityGrant {
    const grant = { session_id: randomUUID(), expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: subject, nickname, email: 'member@example.test', approved: true as const } };
    this.grants.set(grant.session_id, grant);
    return grant;
  }
  async exchange(code: string, verifier: string): Promise<IdentityGrant> {
    const entry = this.codes.get(code);
    this.codes.delete(code);
    if (this.outage || !entry || entry.verifier !== verifier) throw unavailable();
    return entry.grant;
  }
  async introspect(id: string): Promise<Introspection> {
    this.calls++;
    if (this.outage) throw unavailable();
    const grant = this.grants.get(id);
    return grant ? { active: true, expires_at: grant.expires_at, user: grant.user } : { active: false };
  }
  async revoke(id: string): Promise<void> {
    if (this.outage) throw unavailable();
    this.grants.delete(id);
  }
}
export const identity = new MockIdentity();

// Existing non-auth tests seed projections directly, never a production password bypass.
export function seedUser(db: Database, username: string, isAdmin = true): UserRecord {
  const id = randomUUID();
  db.run('INSERT INTO users (id, username, display_name, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, username, username, '', Number(isAdmin), new Date().toISOString());
  db.run('INSERT INTO external_identities (subject, user_id) VALUES (?, ?)', id, id);
  return db.get<UserRecord>('SELECT * FROM users WHERE id = ?', id)!;
}
export function login(auth: AuthService, user: UserRecord, provider = identity) {
  return auth.createSession(provider.grant(user.id, user.display_name)).token;
}
export function humanHeaders(token: string) {
  return { host: new URL(config.publicUrl).host, origin: config.publicUrl, cookie: `__Host-overroot_session=${token}` };
}
export async function buildApp(options: BuildAppOptions = {}) {
  const built = await buildProductionApp({ identityProvider: identity, ...options });
  // Fastify inject defaults to localhost, unlike the configured browser host.
  built.app.inject = new Proxy(built.app.inject, {
    apply(target, thisArg, args) {
      const input = args[0];
      args[0] = typeof input === 'string' ? { url: input, headers: { host: new URL(config.publicUrl).host } } : { ...input, headers: { host: new URL(config.publicUrl).host, origin: config.publicUrl, ...input.headers } };
      return Reflect.apply(target, thisArg, args);
    }
  });
  return built;
}
