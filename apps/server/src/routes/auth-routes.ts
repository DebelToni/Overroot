import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { cookie, publicUser, SESSION_COOKIE, sessionCookie } from '../auth.js';
import { config } from '../config.js';
import type { AppContext } from '../context.js';
import { HttpError } from '../errors.js';
import type { UserRecord } from '../types.js';

const ATTEMPT_COOKIE = '__Host-overroot_login';
export function localReturnPath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048 || !value.startsWith('/#/') || /[\\\r\n]/.test(value)) return '/#/';
  return value;
}

export function registerAuthRoutes(app: FastifyInstance, context: AppContext): void {
  const attempts = new Map<string, { verifier: string; returnTo: string; expires: number }>();
  app.addHook('preClose', async () => { attempts.clear(); });
  app.get('/api/v1/status', async () => ({ ok: true, name: 'Overroot', version: '0.1.0', publicUrl: config.publicUrl, identityOrigin: context.auth.identity.origin, serverTime: new Date().toISOString() }));
  app.get('/api/v1/auth/start', async (request, reply) => {
    context.auth.assertMigrated();
    const now = Date.now();
    for (const [key, attempt] of attempts) if (attempt.expires <= now) attempts.delete(key);
    if (attempts.size >= 1000) throw new HttpError(429, 'Too many sign-in attempts. Try again shortly.', 'rate_limited');
    const previous = cookie(request, ATTEMPT_COOKIE);
    if (previous) attempts.delete(previous);
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const query = z.object({ returnTo: z.string().optional() }).parse(request.query);
    attempts.set(state, { verifier, returnTo: localReturnPath(query.returnTo), expires: now + 120_000 });
    const url = new URL('/api/accounts/authorize', context.auth.identity.origin);
    url.search = new URLSearchParams({ client_id: 'overroot', redirect_uri: context.auth.identity.callback, response_type: 'code', state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString();
    reply.header('Cache-Control', 'no-store');
    reply.header('Set-Cookie', sessionCookie(ATTEMPT_COOKIE, state, 120));
    return reply.redirect(url.toString());
  });
  app.get('/api/v1/auth/callback', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const query = z.object({ state: z.string().min(1).max(256), code: z.string().min(1).max(512) }).parse(request.query);
    const browser = cookie(request, ATTEMPT_COOKIE);
    const attempt = browser === query.state ? attempts.get(query.state) : undefined;
    if (browser === query.state) attempts.delete(query.state);
    reply.header('Set-Cookie', sessionCookie(ATTEMPT_COOKIE, '', 0));
    if (!attempt || attempt.expires <= Date.now()) throw new HttpError(400, 'Invalid or expired sign-in attempt. Start again.', 'invalid_state');
    const grant = await context.auth.identity.exchange(query.code, attempt.verifier);
    const session = context.auth.createSession(grant);
    reply.header('Set-Cookie', [sessionCookie(ATTEMPT_COOKIE, '', 0), sessionCookie(SESSION_COOKIE, session.token, session.maxAge)]);
    return reply.redirect(attempt.returnTo);
  });
  app.get('/api/v1/auth/account', async (_request, reply) => reply.redirect(context.auth.identity.origin));
  app.get('/api/v1/auth/me', async (request) => {
    const actor = context.auth.requireUser(request);
    return { user: publicUser(context.db.get<UserRecord>('SELECT * FROM users WHERE id = ?', actor.id)!) };
  });
  app.post('/api/v1/auth/logout', async (request, reply) => {
    const actor = context.auth.requireUser(request);
    await context.auth.logout(actor);
    context.gateway.closeSession(actor.sessionHash);
    reply.header('Set-Cookie', sessionCookie(SESSION_COOKIE, '', 0));
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

}
