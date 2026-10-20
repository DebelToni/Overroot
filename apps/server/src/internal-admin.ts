import { isIP } from 'node:net';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from './context.js';
import { HttpError } from './errors.js';
import { safeEqualText, sha256 } from './security.js';

export const INTERNAL_USERS_PATH = '/api/internal/admin/users';

export function requireInternalAdmin(request: FastifyRequest): void {
  const peer = request.raw.socket.remoteAddress ?? '';
  const ipv4 = peer.startsWith('::ffff:') ? peer.slice(7) : peer;
  const loopback = peer === '::1' || (isIP(ipv4) === 4 && ipv4.startsWith('127.'));
  const key = request.headers['x-accounts-client-key'];
  const expected = process.env.OVERROOT_IDENTITY_CLIENT_SECRET;
  const singleHeader = (name: string) => request.raw.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === name).length === 1;
  if (request.headers.host !== 'overroot.admin.internal' || !loopback ||
      !singleHeader('host') || !singleHeader('x-accounts-client-key') ||
      typeof key !== 'string' || !expected || expected.length < 32 ||
      !safeEqualText(sha256(key), sha256(expected))) {
    throw new HttpError(403, 'Internal administration access denied', 'internal_admin_denied');
  }
}

export function registerInternalAdminRoutes(app: FastifyInstance, context: AppContext): void {
  app.get(INTERNAL_USERS_PATH, async () => ({
    users: context.db.all<{ id: string; subject: string | null; username: string; displayName: string; isAdmin: number; createdAt: string }>(
      `SELECT u.id, e.subject, u.username, u.display_name AS displayName, u.is_admin AS isAdmin, u.created_at AS createdAt
       FROM users u LEFT JOIN external_identities e ON e.user_id = u.id ORDER BY u.created_at, u.id`
    ).map((user) => ({ ...user, isAdmin: user.isAdmin === 1 }))
  }));
}
