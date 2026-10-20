import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { cookie, publicUser, SESSION_COOKIE, sessionCookie } from '../auth.js';
import { config } from '../config.js';
import type { AppContext } from '../context.js';
import { HttpError } from '../errors.js';
import type { IdentityGrant } from '../identity.js';
import type { UserRecord } from '../types.js';

const ATTEMPT_COOKIE = '__Host-overroot_login';
const INVALID_ATTEMPT_REDIRECT = '/#/login?authError=invalid_attempt';
export function localReturnPath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048 || !value.startsWith('/#/') || /[\\\r\n]/.test(value)) return '/#/';
  return value;
}

export function registerAuthRoutes(app: FastifyInstance, context: AppContext): void {
  const loginLimiter = new LoginLimiter();
  const attempts = new Map<string, { verifier: string; returnTo: string; expires: number }>();
  app.addHook('preClose', async () => { attempts.clear(); loginLimiter.clear(); });
  app.get('/api/v1/status', async () => ({ ok: true, name: 'Overroot', version: '0.1.0', publicUrl: config.publicUrl, identityOrigin: context.auth.identity.origin, serverTime: new Date().toISOString() }));
  app.get('/api/v1/auth/start', async (request, reply) => {
    context.auth.assertMigrated();
    const now = Date.now();
    // The closest forwarded address is appended by the trusted ingress, unlike
    // an attacker-supplied leftmost X-Forwarded-For entry with trustProxy=true.
    loginLimiter.admit(request.ips?.[1] ?? request.ip, now);
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
    const query = z.object({ state: z.string().min(1).max(256), code: z.string().min(1).max(512) }).safeParse(request.query);
    reply.header('Set-Cookie', sessionCookie(ATTEMPT_COOKIE, '', 0));
    if (!query.success) return reply.redirect(INVALID_ATTEMPT_REDIRECT);
    const browser = cookie(request, ATTEMPT_COOKIE);
    const attempt = browser === query.data.state ? attempts.get(query.data.state) : undefined;
    if (browser === query.data.state) attempts.delete(query.data.state);
    if (!attempt || attempt.expires <= Date.now()) return reply.redirect(INVALID_ATTEMPT_REDIRECT);
    let grant: IdentityGrant;
    try { grant = await context.auth.identity.exchange(query.data.code, attempt.verifier); }
    catch (error) {
      if (error instanceof HttpError && error.statusCode === 503) return reply.redirect('/#/login?authError=accounts_unavailable');
      throw error;
    }
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

  app.get('/api/v1/auth/admin', async (request, reply) => {
    const actor = context.auth.requireUser(request);
    if (!actor.isAdmin) throw new HttpError(403, 'Local administrator entry required', 'admin_required');
    // This is only a navigation affordance. The issuer independently requires
    // its configured owner, then redirects to the private administration origin.
    return reply.redirect(new URL('/admin', context.auth.identity.origin).toString());
  });

}

// Adapted from the former local-password LoginLimiter: only IP admission is
// relevant now; no account/password work or success-based reset remains.
class LoginLimiter {
  private readonly attempts = new Map<string, number[]>();

  admit(ip: string, now: number): void {
    for (const [key, times] of this.attempts) {
      const recent = times.filter((time) => now - time < 5 * 60_000);
      if (recent.length) this.attempts.set(key, recent);
      else this.attempts.delete(key);
    }
    const recent = this.attempts.get(ip) ?? [];
    if (recent.length >= 12 || (!this.attempts.has(ip) && this.attempts.size >= 4096)) {
      throw new HttpError(429, 'Too many sign-in attempts. Try again in a few minutes.', 'rate_limited');
    }
    recent.push(now);
    this.attempts.set(ip, recent);
  }

  clear(): void { this.attempts.clear(); }
}
