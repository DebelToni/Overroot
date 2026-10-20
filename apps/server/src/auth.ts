import { randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { Database } from './database.js';
import { HttpError } from './errors.js';
import type { IdentityGrant, IdentityProvider } from './identity.js';
import { projectAccess } from './permissions.js';
import type { WebSocketTicket } from './websockets.js';
import { randomToken, sha256 } from './security.js';
import type { AgentRecord, AuthActor, UserRecord } from './types.js';

export const SESSION_COOKIE = '__Host-overroot_session';
export function cookie(request: FastifyRequest, name: string): string | undefined {
  const values = (request.headers.cookie ?? '').split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));
  return values.length === 1 ? values[0]!.slice(name.length + 1) : undefined;
}
export function sessionCookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
interface SessionRow extends UserRecord {
  central_session_id: string | null;
  expires_at: string;
  subject: string;
}

export class AuthService {
  private readonly actors = new WeakMap<FastifyRequest, AuthActor>();
  constructor(private readonly db: Database, readonly identity: IdentityProvider) {}

  assertMigrated(): void {
    if (!this.db.get<{ completed: number }>('SELECT completed FROM identity_migration WHERE id = 1')?.completed ||
        this.db.get('SELECT id FROM users WHERE id NOT IN (SELECT user_id FROM external_identities) LIMIT 1')) {
      throw new HttpError(503, 'Explicit shared-account identity migration is required', 'identity_migration_required');
    }
  }

  createSession(grant: IdentityGrant): { token: string; user: PublicUser; maxAge: number } {
    this.assertMigrated();
    if (!grant.user.approved || grant.expires_at * 1000 <= Date.now()) throw new HttpError(401, 'Inactive account grant', 'inactive_grant');
    return this.db.transaction(() => {
      let user = this.db.get<UserRecord>('SELECT u.* FROM users u JOIN external_identities e ON e.user_id = u.id WHERE e.subject = ?', grant.user.id);
      if (!user) {
        const id = randomUUID();
        // An opaque unique local handle avoids any email/nickname-based identity matching.
        user = { id, username: `account-${id}`, display_name: grant.user.nickname, password_hash: '', is_admin: 0, created_at: new Date().toISOString() };
        this.db.run('INSERT INTO users (id, username, display_name, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, 0, ?)', id, user.username, user.display_name, '', user.created_at);
        this.db.run('INSERT INTO external_identities (subject, user_id) VALUES (?, ?)', grant.user.id, id);
      }
      const token = randomToken('or_session_');
      const now = new Date().toISOString();
      this.db.run('INSERT INTO sessions (token_hash, user_id, expires_at, last_seen_at, created_at, central_session_id) VALUES (?, ?, ?, ?, ?, ?)', sha256(token), user.id, new Date(grant.expires_at * 1000).toISOString(), now, now, grant.session_id);
      return { token, user: publicUser(user), maxAge: Math.floor(grant.expires_at - Date.now() / 1000) };
    });
  }

  async validateSession(sessionHash: string): Promise<Extract<AuthActor, { type: 'user' }> | null> {
    const row = this.db.get<SessionRow>(`SELECT u.*, s.central_session_id, s.expires_at, e.subject FROM sessions s JOIN users u ON u.id = s.user_id JOIN external_identities e ON e.user_id = u.id WHERE s.token_hash = ?`, sessionHash);
    if (!row?.central_session_id || row.expires_at <= new Date().toISOString()) return null;
    const grant = await this.identity.introspect(row.central_session_id);
    if (!grant.active || !grant.user.approved || grant.user.id !== row.subject || grant.expires_at * 1000 <= Date.now()) {
      this.db.run('DELETE FROM sessions WHERE token_hash = ?', sessionHash);
      return null;
    }
    // Logout can race an in-flight introspection. Never resurrect a deleted session.
    if (!this.db.get('SELECT token_hash FROM sessions WHERE token_hash = ?', sessionHash)) return null;
    return { type: 'user', id: row.id, name: row.display_name, isAdmin: row.is_admin === 1, sessionHash };
  }

  async validateSocket(ticket: WebSocketTicket): Promise<boolean> {
    const actor = await this.validateSession(ticket.sessionHash);
    if (!actor || actor.id !== ticket.actor.id) return false;
    try {
      const access = projectAccess(this.db, actor, ticket.projectHash);
      if (access.project.id !== ticket.projectId) return false;
      if (ticket.channel === 'file') return access.canWrite && Boolean(this.db.get("SELECT id FROM files WHERE id = ? AND project_id = ? AND kind = 'text'", ticket.fileId ?? '', ticket.projectId));
      return true;
    } catch (error) {
      if (error instanceof HttpError && [403, 404].includes(error.statusCode)) return false;
      throw error;
    }
  }

  async prepare(request: FastifyRequest): Promise<void> {
    // Any Authorization header takes precedence, including an invalid agent credential.
    if (request.headers.authorization !== undefined) return;
    const token = cookie(request, SESSION_COOKIE);
    if (!token) return;
    const actor = await this.validateSession(sha256(token));
    if (actor) this.actors.set(request, actor);
  }

  authenticate(request: FastifyRequest): AuthActor | null {
    const header = request.headers.authorization;
    if (header === undefined) return this.actors.get(request) ?? null;
    if (!header.startsWith('Bearer ')) return null;
    const token = header.slice(7).trim();
    if (!token.startsWith('ul_agent_')) return null;
    const tokenHash = sha256(token);
    const row = this.db.get<AgentRecord>(`SELECT a.*, p.public_hash AS project_hash FROM agent_credentials a JOIN projects p ON p.id = a.project_id WHERE a.token_hash = ? AND a.revoked_at IS NULL`, tokenHash);
    if (!row) return null;
    this.db.run('UPDATE agent_credentials SET last_used_at = ? WHERE id = ?', new Date().toISOString(), row.id);
    return { type: 'agent', id: row.id, name: row.name, projectId: row.project_id, projectHash: row.project_hash, tokenHash };
  }
  require(request: FastifyRequest): AuthActor {
    const actor = this.authenticate(request);
    if (!actor) throw new HttpError(401, 'Authentication required', 'authentication_required');
    return actor;
  }
  requireUser(request: FastifyRequest): Extract<AuthActor, { type: 'user' }> {
    const actor = this.require(request);
    if (actor.type !== 'user') throw new HttpError(403, 'A human account is required', 'human_account_required');
    return actor;
  }
  async logout(actor: Extract<AuthActor, { type: 'user' }>): Promise<void> {
    const row = this.db.get<{ central_session_id: string }>('SELECT central_session_id FROM sessions WHERE token_hash = ?', actor.sessionHash);
    // Keep the session on an outage so a retry can revoke the upstream grant.
    if (row?.central_session_id) await this.identity.revoke(row.central_session_id);
    this.db.run('DELETE FROM sessions WHERE token_hash = ?', actor.sessionHash);
  }
  cleanup(): void {
    this.db.run('DELETE FROM sessions WHERE expires_at <= ?', new Date().toISOString());
  }
}

export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  isAdmin: boolean;
  createdAt: string;
}

export function publicUser(user: UserRecord): PublicUser {
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    isAdmin: user.is_admin === 1,
    createdAt: user.created_at
  };
}
