import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { publicUser } from '../auth.js';
import { config } from '../config.js';
import type { AppContext } from '../context.js';
import { HttpError } from '../errors.js';
import { hashPassword, randomToken, sha256, verifyPassword } from '../security.js';
import type { UserRecord } from '../types.js';

const credentialsSchema = z.object({ username: z.string(), password: z.string() });

export function registerAuthRoutes(app: FastifyInstance, context: AppContext): void {
  const loginLimiter = new LoginLimiter();

  app.get('/api/v1/status', async () => {
    const count = context.db.get<{ count: number }>('SELECT COUNT(*) AS count FROM users')?.count ?? 0;
    return {
      ok: true,
      name: 'Overroot',
      version: '0.1.0',
      setupRequired: Number(count) === 0,
      publicUrl: config.publicUrl,
      serverTime: new Date().toISOString()
    };
  });

  app.post('/api/v1/auth/login', async (request) => {
    const input = credentialsSchema.parse(request.body);
    return loginLimiter.run(request.ip, input.username, () => context.auth.login(input.username, input.password));
  });

  app.get('/api/v1/auth/me', async (request) => {
    const actor = context.auth.requireUser(request);
    const user = context.db.get<UserRecord>('SELECT * FROM users WHERE id = ?', actor.id)!;
    return { user: publicUser(user) };
  });

  app.post('/api/v1/auth/logout', async (request, reply) => {
    const actor = context.auth.requireUser(request);
    context.gateway.closeSession(actor.sessionHash);
    context.auth.logout(actor);
    return reply.code(204).send();
  });

  app.post('/api/v1/auth/register', async (request) => {
    const input = z
      .object({ invite: z.string().min(1), username: z.string(), password: z.string() })
      .parse(request.body);
    await context.auth.registerWithInvite(input.invite, input.username, input.password);
    return context.auth.login(input.username, input.password);
  });

  app.post('/api/v1/auth/password', async (request, reply) => {
    const actor = context.auth.requireUser(request);
    const input = z.object({ currentPassword: z.string(), newPassword: z.string().min(8).max(256) }).parse(request.body);
    const user = context.db.get<UserRecord>('SELECT * FROM users WHERE id = ?', actor.id)!;
    if (!(await verifyPassword(input.currentPassword, user.password_hash))) {
      throw new HttpError(401, 'Current password is incorrect', 'invalid_password');
    }
    context.db.run('UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(input.newPassword), user.id);
    context.db.run('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?', user.id, actor.sessionHash);
    context.gateway.closeOtherUserSessions(user.id, actor.sessionHash);
    return reply.code(204).send();
  });

  app.get('/api/v1/users', async (request) => {
    context.auth.requireUser(request);
    const query = z.object({ q: z.string().default('') }).parse(request.query);
    const value = `%${query.q.trim().slice(0, 50)}%`;
    const users = context.db.all<UserRecord>(
      'SELECT * FROM users WHERE username LIKE ? OR display_name LIKE ? ORDER BY username LIMIT 20',
      value,
      value
    );
    return { users: users.map(publicUser) };
  });

  app.get('/api/v1/admin/users', async (request) => {
    const actor = context.auth.requireUser(request);
    if (!actor.isAdmin) throw new HttpError(403, 'Administrator access is required', 'admin_required');
    return { users: context.db.all<UserRecord>('SELECT * FROM users ORDER BY created_at').map(publicUser) };
  });

  app.get('/api/v1/admin/invites', async (request) => {
    const actor = context.auth.requireUser(request);
    if (!actor.isAdmin) throw new HttpError(403, 'Administrator access is required', 'admin_required');
    return {
      invites: context.db.all(
        `SELECT i.id, i.expires_at AS expiresAt, i.used_at AS usedAt, i.created_at AS createdAt,
                creator.username AS createdBy, used.username AS usedBy
         FROM invites i
         JOIN users creator ON creator.id = i.created_by
         LEFT JOIN users used ON used.id = i.used_by
         ORDER BY i.created_at DESC`
      )
    };
  });

  app.post('/api/v1/admin/invites', async (request, reply) => {
    const actor = context.auth.requireUser(request);
    if (!actor.isAdmin) throw new HttpError(403, 'Administrator access is required', 'admin_required');
    const input = z.object({ expiresInDays: z.number().int().min(1).max(30).default(7) }).parse(request.body ?? {});
    const token = randomToken('ul_invite_', 24);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + input.expiresInDays * 86_400_000).toISOString();
    const id = randomUUID();
    context.db.run(
      `INSERT INTO invites (id, token_hash, created_by, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      id,
      sha256(token),
      actor.id,
      expiresAt,
      now.toISOString()
    );
    return reply.code(201).send({
      id,
      token,
      expiresAt,
      registrationUrl: `${config.publicUrl}/#/register?invite=${encodeURIComponent(token)}`
    });
  });

  app.delete('/api/v1/admin/invites/:id', async (request, reply) => {
    const actor = context.auth.requireUser(request);
    if (!actor.isAdmin) throw new HttpError(403, 'Administrator access is required', 'admin_required');
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    context.db.run('DELETE FROM invites WHERE id = ? AND used_at IS NULL', id);
    return reply.code(204).send();
  });
}

class LoginLimiter {
  private readonly attempts = new Map<string, number[]>();
  private active = 0;

  async run<T>(ip: string, username: string, action: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const keys: Array<[string, number]> = [
      [`ip:${ip}`, 12],
      [`account:${ip}:${username.trim().toLowerCase()}`, 6]
    ];
    for (const [key, limit] of keys) {
      const recent = (this.attempts.get(key) ?? []).filter((time) => now - time < 5 * 60_000);
      if (recent.length >= limit) {
        throw new HttpError(429, 'Too many login attempts. Try again in a few minutes.', 'rate_limited');
      }
      recent.push(now);
      this.attempts.set(key, recent);
    }
    if (this.active >= 4) throw new HttpError(429, 'The login service is busy. Try again shortly.', 'rate_limited');
    this.active += 1;
    try {
      const result = await action();
      for (const [key] of keys) this.attempts.delete(key);
      return result;
    } finally {
      this.active -= 1;
    }
  }
}
