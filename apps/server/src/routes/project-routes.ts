import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorIdentity } from '../actor.js';
import { audit } from '../audit.js';
import { config } from '../config.js';
import type { AppContext } from '../context.js';
import { HttpError } from '../errors.js';
import { projectAccess, requireOwner } from '../permissions.js';
import { safeUnzip } from '../safe-zip.js';
import { randomToken, sha256 } from '../security.js';
import { projectTemplates } from '../templates.js';
import type { UserRecord } from '../types.js';

const MAX_ZIP_BYTES = 25 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 60 * 1024 * 1024;
const MAX_ARCHIVE_FILES = 500;

export function registerProjectRoutes(app: FastifyInstance, context: AppContext): void {
  app.get('/api/v1/templates', async (request) => {
    context.auth.requireUser(request);
    return {
      templates: projectTemplates.map(({ id, name, description, entryFile }) => ({ id, name, description, entryFile }))
    };
  });

  app.get('/api/v1/projects', async (request) => {
    const actor = context.auth.requireUser(request);
    return { projects: context.projects.listForUser(actor.id).map(projectSummary) };
  });

  app.post('/api/v1/projects', async (request, reply) => {
    const actor = context.auth.requireUser(request);
    const input = z.object({ name: z.string(), template: z.string().default('article') }).parse(request.body);
    const project = context.projects.createProject(actor.id, input.name, input.template);
    audit(context.db, project.id, actorIdentity(actor), 'project.created', { template: input.template });
    return reply.code(201).send({ project: projectDetail(context, project.public_hash, actor) });
  });

  app.post('/api/v1/projects/import', async (request, reply) => {
    const actor = context.auth.requireUser(request);
    const upload = await request.file({ limits: { fileSize: MAX_ZIP_BYTES, files: 1 } });
    if (!upload) throw new HttpError(400, 'A ZIP archive is required', 'archive_required');
    const bytes = await upload.toBuffer();
    const entries = safeUnzip(bytes, { maxFiles: MAX_ARCHIVE_FILES, maxUnpackedBytes: MAX_UNPACKED_BYTES });
    const names = Object.keys(entries).filter((name) => !name.startsWith('__MACOSX/') && !name.endsWith('/.DS_Store'));
    if (names.length > MAX_ARCHIVE_FILES) throw new HttpError(413, 'The archive contains too many files', 'archive_too_large');
    const root = commonRoot(names);
    let total = 0;
    const files = names.map((name) => {
      const content = entries[name]!;
      total += content.byteLength;
      const path = root && name.startsWith(`${root}/`) ? name.slice(root.length + 1) : name;
      return { path, content };
    });
    if (total > MAX_UNPACKED_BYTES) throw new HttpError(413, 'The unpacked archive is too large', 'archive_too_large');
    const originalName = upload.filename.replace(/\.zip$/i, '') || 'Imported project';
    const project = context.projects.createImportedProject(actor.id, originalName, files);
    audit(context.db, project.id, actorIdentity(actor), 'project.imported', { files: files.length });
    return reply.code(201).send({ project: projectDetail(context, project.public_hash, actor) });
  });

  app.get('/api/v1/projects/:hash', async (request) => {
    const actor = context.auth.require(request);
    const { hash } = z.object({ hash: z.string() }).parse(request.params);
    projectAccess(context.db, actor, hash);
    return { project: projectDetail(context, hash, actor) };
  });

  app.patch('/api/v1/projects/:hash', async (request) => {
    const actor = context.auth.require(request);
    const { hash } = z.object({ hash: z.string() }).parse(request.params);
    const access = projectAccess(context.db, actor, hash);
    requireOwner(access);
    const input = z.object({ name: z.string().min(1).max(100).optional() }).parse(request.body);
    if (input.name) {
      const name = input.name.trim();
      context.db.run('UPDATE projects SET name = ?, updated_at = ? WHERE id = ?', name, new Date().toISOString(), access.project.id);
    }
    audit(context.db, access.project.id, actorIdentity(actor), 'project.updated', input);
    context.events.emit(access.project.id, { type: 'project.updated' });
    return { project: projectDetail(context, hash, actor) };
  });

  app.delete('/api/v1/projects/:hash', async (request, reply) => {
    const actor = context.auth.require(request);
    const { hash } = z.object({ hash: z.string() }).parse(request.params);
    const access = projectAccess(context.db, actor, hash);
    requireOwner(access);
    context.gateway.closeProject(access.project.id);
    for (const file of context.projects.listFiles(access.project.id)) await context.collaboration.remove(file.id);
    context.db.run('DELETE FROM projects WHERE id = ?', access.project.id);
    return reply.code(204).send();
  });

  app.get('/api/v1/projects/:hash/members', async (request) => {
    const actor = context.auth.require(request);
    const { hash } = z.object({ hash: z.string() }).parse(request.params);
    const access = projectAccess(context.db, actor, hash);
    return {
      members: context.db.all(
        `SELECT u.id, u.username, u.display_name AS displayName, pm.role, pm.created_at AS addedAt
         FROM project_members pm JOIN users u ON u.id = pm.user_id
         WHERE pm.project_id = ? ORDER BY CASE pm.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END, u.username`,
        access.project.id
      )
    };
  });

  app.post('/api/v1/projects/:hash/members', async (request, reply) => {
    const actor = context.auth.require(request);
    const { hash } = z.object({ hash: z.string() }).parse(request.params);
    const access = projectAccess(context.db, actor, hash);
    requireOwner(access);
    const input = z.object({ username: z.string(), role: z.enum(['editor', 'viewer']) }).parse(request.body);
    const user = context.db.get<UserRecord>('SELECT * FROM users WHERE username = ?', input.username.trim());
    if (!user) throw new HttpError(404, 'User not found', 'user_not_found');
    if (user.id === access.project.owner_id) throw new HttpError(400, 'The owner role cannot be changed', 'owner_immutable');
    context.db.run(
      `INSERT INTO project_members (project_id, user_id, role, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(project_id, user_id) DO UPDATE SET role = excluded.role`,
      access.project.id,
      user.id,
      input.role,
      new Date().toISOString()
    );
    context.gateway.closeUserProject(user.id, access.project.id);
    audit(context.db, access.project.id, actorIdentity(actor), 'member.saved', { username: user.username, role: input.role });
    context.events.emit(access.project.id, { type: 'members.changed' });
    return reply.code(201).send({ member: { id: user.id, username: user.username, role: input.role } });
  });

  app.patch('/api/v1/projects/:hash/members/:userId', async (request) => {
    const actor = context.auth.require(request);
    const params = z.object({ hash: z.string(), userId: z.string().uuid() }).parse(request.params);
    const access = projectAccess(context.db, actor, params.hash);
    requireOwner(access);
    const input = z.object({ role: z.enum(['editor', 'viewer']) }).parse(request.body);
    if (params.userId === access.project.owner_id) throw new HttpError(400, 'The owner role cannot be changed', 'owner_immutable');
    const updated = context.db.run(
      'UPDATE project_members SET role = ? WHERE project_id = ? AND user_id = ?',
      input.role,
      access.project.id,
      params.userId
    );
    if (Number(updated.changes) !== 1) throw new HttpError(404, 'Member not found', 'member_not_found');
    context.gateway.closeUserProject(params.userId, access.project.id);
    context.events.emit(access.project.id, { type: 'members.changed' });
    return { ok: true };
  });

  app.delete('/api/v1/projects/:hash/members/:userId', async (request, reply) => {
    const actor = context.auth.require(request);
    const params = z.object({ hash: z.string(), userId: z.string().uuid() }).parse(request.params);
    const access = projectAccess(context.db, actor, params.hash);
    requireOwner(access);
    if (params.userId === access.project.owner_id) throw new HttpError(400, 'The owner cannot be removed', 'owner_immutable');
    context.db.run('DELETE FROM project_members WHERE project_id = ? AND user_id = ?', access.project.id, params.userId);
    context.gateway.closeUserProject(params.userId, access.project.id);
    context.events.emit(access.project.id, { type: 'members.changed' });
    return reply.code(204).send();
  });

  app.get('/api/v1/projects/:hash/agents', async (request) => {
    const actor = context.auth.requireUser(request);
    const { hash } = z.object({ hash: z.string() }).parse(request.params);
    const access = projectAccess(context.db, actor, hash);
    requireOwner(access);
    return {
      agents: context.db.all(
        `SELECT id, name, created_at AS createdAt, last_used_at AS lastUsedAt, revoked_at AS revokedAt
         FROM agent_credentials WHERE project_id = ? ORDER BY created_at DESC`,
        access.project.id
      )
    };
  });

  app.post('/api/v1/projects/:hash/agents', async (request, reply) => {
    const actor = context.auth.requireUser(request);
    const { hash } = z.object({ hash: z.string() }).parse(request.params);
    const access = projectAccess(context.db, actor, hash);
    requireOwner(access);
    const input = z.object({ name: z.string().trim().min(1).max(60) }).parse(request.body);
    const password = randomToken('ul_agent_', 32);
    const id = randomUUID();
    const now = new Date().toISOString();
    context.db.run(
      `INSERT INTO agent_credentials (id, project_id, name, token_hash, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      access.project.id,
      input.name,
      sha256(password),
      actor.id,
      now
    );
    audit(context.db, access.project.id, actorIdentity(actor), 'agent.created', { id, name: input.name });
    return reply.code(201).send({
      agent: { id, name: input.name, createdAt: now },
      access: {
        link: config.publicUrl,
        projectHash: access.project.public_hash,
        password,
        guide: `${config.publicUrl}/agent-guide.md`
      }
    });
  });

  app.delete('/api/v1/projects/:hash/agents/:agentId', async (request, reply) => {
    const actor = context.auth.requireUser(request);
    const params = z.object({ hash: z.string(), agentId: z.string().uuid() }).parse(request.params);
    const access = projectAccess(context.db, actor, params.hash);
    requireOwner(access);
    context.db.run(
      'UPDATE agent_credentials SET revoked_at = ? WHERE id = ? AND project_id = ?',
      new Date().toISOString(),
      params.agentId,
      access.project.id
    );
    audit(context.db, access.project.id, actorIdentity(actor), 'agent.revoked', { id: params.agentId });
    return reply.code(204).send();
  });

  app.get('/api/v1/agent/context', async (request) => {
    const actor = context.auth.require(request);
    if (actor.type !== 'agent') throw new HttpError(403, 'An agent password is required', 'agent_required');
    const access = projectAccess(context.db, actor, actor.projectHash);
    return {
      project: projectDetail(context, access.project.public_hash, actor),
      capabilities: ['project:read', 'file:create', 'file:read', 'file:write', 'file:rename', 'file:delete', 'compile:start', 'compile:read'],
      concurrency: { mutationsRequireIfMatch: true, conflictStatus: 409 },
      openapi: '/api/v1/openapi.json'
    };
  });

  app.get('/api/v1/projects/:hash/audit', async (request) => {
    const actor = context.auth.require(request);
    const { hash } = z.object({ hash: z.string() }).parse(request.params);
    const access = projectAccess(context.db, actor, hash);
    return {
      events: context.db.all(
        `SELECT id, actor_type AS actorType, actor_id AS actorId, actor_name AS actorName,
                action, metadata_json AS metadata, created_at AS createdAt
         FROM audit_events WHERE project_id = ? ORDER BY created_at DESC LIMIT 200`,
        access.project.id
      )
    };
  });
}

function projectDetail(context: AppContext, hash: string, actor: ReturnType<AppContext['auth']['require']>) {
  const access = projectAccess(context.db, actor, hash);
  const owner = context.db.get<{ username: string }>('SELECT username FROM users WHERE id = ?', access.project.owner_id);
  const members = context.db.get<{ count: number }>('SELECT COUNT(*) AS count FROM project_members WHERE project_id = ?', access.project.id);
  const latest = context.compiler.latest(access.project.id);
  return {
    hash: access.project.public_hash,
    name: access.project.name,
    entryFile: access.project.entry_file,
    owner: owner?.username,
    role: access.role,
    canWrite: access.canWrite,
    canManage: access.canManage,
    memberCount: Number(members?.count ?? 0),
    createdAt: access.project.created_at,
    updatedAt: access.project.updated_at,
    latestCompile: latest ? { id: latest.id, status: latest.status, finishedAt: latest.finished_at, hasPdf: Boolean(latest.pdf_path) } : null
  };
}

function projectSummary(project: any) {
  return {
    hash: project.public_hash,
    name: project.name,
    entryFile: project.entry_file,
    role: project.role,
    owner: project.owner_name,
    memberCount: Number(project.member_count),
    latestCompileStatus: project.latest_compile_status,
    createdAt: project.created_at,
    updatedAt: project.updated_at
  };
}

function commonRoot(paths: string[]): string | null {
  if (!paths.length) return null;
  const first = paths[0]!.split('/')[0]!;
  return paths.every((path) => path.includes('/') && path.split('/')[0] === first) ? first : null;
}
