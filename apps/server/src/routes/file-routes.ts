import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { zipSync } from 'fflate';
import { z } from 'zod';
import { actorIdentity } from '../actor.js';
import { audit } from '../audit.js';
import type { AppContext } from '../context.js';
import { HttpError } from '../errors.js';
import { normalizeProjectPath } from '../paths.js';
import { projectAccess, requireWrite } from '../permissions.js';
import type { AuthActor, FileRecord } from '../types.js';

const MAX_TEXT_BYTES = 5 * 1024 * 1024;
const MAX_BINARY_BYTES = 20 * 1024 * 1024;

export function registerFileRoutes(app: FastifyInstance, context: AppContext): void {
  app.get('/api/v1/projects/:hash/files', async (request) => {
    const { actor, projectId } = fileAccess(context, request);
    void actor;
    return { files: context.projects.listFiles(projectId).map(fileMetadata) };
  });

  app.post('/api/v1/projects/:hash/files', async (request, reply) => {
    const { actor, access } = fileAccess(context, request, true);
    const input = fileBodySchema.parse(request.body);
    const content = decodeContent(input);
    assertFileSize(content, input.content != null);
    const file = context.projects.addFile(access.project.id, input.path, content, input.mimeType, actorIdentity(actor));
    audit(context.db, access.project.id, actorIdentity(actor), 'file.created', { path: file.path });
    context.events.emit(access.project.id, { type: 'file.created', file: fileMetadata(file), actor: actorIdentity(actor) });
    return reply.code(201).send({ file: fileResponse(file, content) });
  });

  app.get('/api/v1/projects/:hash/files/:fileId', async (request, reply) => {
    const { access } = fileAccess(context, request);
    const { fileId } = fileParams(request);
    const current = context.collaboration.current(fileId);
    assertFileProject(current.file, access.project.id);
    setEtag(reply, current.revision);
    return { file: fileResponse(current.file, current.content, current.revision) };
  });

  app.get('/api/v1/projects/:hash/files/:fileId/raw', async (request, reply) => {
    const { access } = fileAccess(context, request);
    const { fileId } = fileParams(request);
    const current = context.collaboration.current(fileId);
    assertFileProject(current.file, access.project.id);
    setEtag(reply, current.revision);
    return reply.type(current.file.mime_type).send(Buffer.from(current.content));
  });

  app.put('/api/v1/projects/:hash/files/:fileId', async (request, reply) => {
    const { actor, access } = fileAccess(context, request, true);
    const { fileId } = fileParams(request);
    const current = context.collaboration.current(fileId);
    assertFileProject(current.file, access.project.id);
    requireAgentRevision(actor, request, current.revision);
    const input = z.object({ content: z.string().optional(), contentBase64: z.string().optional() }).parse(request.body);
    const content = decodeContent(input);
    assertFileSize(content, input.content != null);

    let saved: FileRecord;
    if (current.file.kind === 'text') {
      if (input.content == null) throw new HttpError(400, 'Text files require UTF-8 content', 'text_content_required');
      saved = await context.collaboration.replaceText(fileId, input.content, actorIdentity(actor));
    } else {
      saved = context.projects.saveFile(fileId, content, actorIdentity(actor));
      context.events.emit(access.project.id, {
        type: actor.type === 'agent' ? 'agent.changed' : 'file.changed',
        fileId,
        path: saved.path,
        revision: saved.revision_hash,
        actor: actorIdentity(actor)
      });
    }
    audit(context.db, access.project.id, actorIdentity(actor), 'file.updated', { path: saved.path, revision: saved.revision_hash });
    setEtag(reply, saved.revision_hash);
    return { file: fileResponse(saved, saved.content) };
  });

  app.patch('/api/v1/projects/:hash/files/:fileId', async (request, reply) => {
    const { actor, access } = fileAccess(context, request, true);
    const { fileId } = fileParams(request);
    const current = context.collaboration.current(fileId);
    assertFileProject(current.file, access.project.id);
    requireAgentRevision(actor, request, current.revision);
    const input = z.object({ path: z.string() }).parse(request.body);
    const renamed = context.projects.renameFile(fileId, input.path);
    audit(context.db, access.project.id, actorIdentity(actor), 'file.renamed', { from: current.file.path, to: renamed.path });
    context.events.emit(access.project.id, {
      type: 'file.renamed',
      fileId,
      from: current.file.path,
      to: renamed.path,
      actor: actorIdentity(actor)
    });
    setEtag(reply, renamed.revision_hash);
    return { file: fileMetadata(renamed) };
  });

  app.delete('/api/v1/projects/:hash/files/:fileId', async (request, reply) => {
    const { actor, access } = fileAccess(context, request, true);
    const { fileId } = fileParams(request);
    const current = context.collaboration.current(fileId);
    assertFileProject(current.file, access.project.id);
    requireAgentRevision(actor, request, current.revision);
    if (current.file.path === access.project.entry_file) {
      throw new HttpError(400, 'Choose another entry file before deleting this one', 'entry_file_required');
    }
    await context.collaboration.remove(fileId);
    context.projects.deleteFile(fileId);
    audit(context.db, access.project.id, actorIdentity(actor), 'file.deleted', { path: current.file.path });
    context.events.emit(access.project.id, {
      type: 'file.deleted',
      fileId,
      path: current.file.path,
      actor: actorIdentity(actor)
    });
    return reply.code(204).send();
  });

  app.get('/api/v1/projects/:hash/files/:fileId/revisions', async (request) => {
    const { access } = fileAccess(context, request);
    const { fileId } = fileParams(request);
    const file = context.projects.getFileById(fileId);
    if (!file) throw new HttpError(404, 'File not found', 'file_not_found');
    assertFileProject(file, access.project.id);
    return {
      revisions: context.db.all(
        `SELECT id, revision_hash AS revision, actor_type AS actorType, actor_id AS actorId,
                actor_name AS actorName, created_at AS createdAt, length(content) AS size
         FROM file_revisions WHERE file_id = ? ORDER BY created_at DESC LIMIT 200`,
        fileId
      )
    };
  });

  app.get('/api/v1/projects/:hash/files/:fileId/revisions/:revisionId', async (request) => {
    const { access } = fileAccess(context, request);
    const params = z.object({ fileId: z.string().uuid(), revisionId: z.string().uuid() }).parse(request.params);
    const file = context.projects.getFileById(params.fileId);
    if (!file) throw new HttpError(404, 'File not found', 'file_not_found');
    assertFileProject(file, access.project.id);
    const revision = context.db.get<any>(
      `SELECT id, revision_hash, content, actor_type, actor_id, actor_name, created_at
       FROM file_revisions WHERE id = ? AND file_id = ?`,
      params.revisionId,
      params.fileId
    );
    if (!revision) throw new HttpError(404, 'Revision not found', 'revision_not_found');
    return {
      revision: {
        id: revision.id,
        revision: revision.revision_hash,
        content: file.kind === 'text' ? Buffer.from(revision.content).toString('utf8') : undefined,
        contentBase64: file.kind === 'binary' ? Buffer.from(revision.content).toString('base64') : undefined,
        actorType: revision.actor_type,
        actorId: revision.actor_id,
        actorName: revision.actor_name,
        createdAt: revision.created_at,
        size: Buffer.from(revision.content).byteLength
      }
    };
  });

  app.post('/api/v1/projects/:hash/files/:fileId/revisions/:revisionId/restore', async (request, reply) => {
    const { actor, access } = fileAccess(context, request, true);
    const params = z.object({ fileId: z.string().uuid(), revisionId: z.string().uuid() }).parse(request.params);
    const file = context.projects.getFileById(params.fileId);
    if (!file) throw new HttpError(404, 'File not found', 'file_not_found');
    assertFileProject(file, access.project.id);
    const current = context.collaboration.current(params.fileId);
    requireAgentRevision(actor, request, current.revision);
    const revision = context.db.get<{ content: Uint8Array }>(
      'SELECT content FROM file_revisions WHERE id = ? AND file_id = ?',
      params.revisionId,
      params.fileId
    );
    if (!revision) throw new HttpError(404, 'Revision not found', 'revision_not_found');
    const restored =
      file.kind === 'text'
        ? await context.collaboration.replaceText(file.id, Buffer.from(revision.content).toString('utf8'), actorIdentity(actor))
        : context.projects.saveFile(file.id, revision.content, actorIdentity(actor));
    audit(context.db, access.project.id, actorIdentity(actor), 'revision.restored', { path: file.path, revisionId: params.revisionId });
    setEtag(reply, restored.revision_hash);
    return { file: fileResponse(restored, restored.content) };
  });

  app.get('/api/v1/projects/:hash/export.zip', async (request, reply) => {
    const { access } = fileAccess(context, request);
    await context.collaboration.flushProject(access.project.id);
    const entries: Record<string, Uint8Array> = {};
    for (const file of context.projects.listFiles(access.project.id)) entries[file.path] = Buffer.from(file.content);
    const zip = zipSync(entries, { level: 6 });
    const safeName = access.project.name.replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-|-$/g, '') || 'overroot-project';
    return reply
      .header('Content-Disposition', `attachment; filename="${safeName}.zip"`)
      .type('application/zip')
      .send(Buffer.from(zip));
  });
}

const fileBodySchema = z
  .object({
    path: z.string(),
    content: z.string().optional(),
    contentBase64: z.string().optional(),
    mimeType: z.string().max(200).optional()
  })
  .refine((value) => (value.content == null) !== (value.contentBase64 == null), {
    message: 'Provide exactly one of content or contentBase64'
  });

function fileAccess(context: AppContext, request: FastifyRequest, write = false) {
  const actor = context.auth.require(request);
  const { hash } = z.object({ hash: z.string() }).parse(request.params);
  const access = projectAccess(context.db, actor, hash);
  if (write) requireWrite(access);
  return { actor, access, projectId: access.project.id };
}

function fileParams(request: FastifyRequest): { fileId: string } {
  return z.object({ fileId: z.string().uuid() }).parse(request.params);
}

function decodeContent(input: { content?: string; contentBase64?: string }): Buffer {
  if (input.content != null) return Buffer.from(input.content, 'utf8');
  if (input.contentBase64 != null) {
    try {
      return Buffer.from(input.contentBase64, 'base64');
    } catch {
      throw new HttpError(400, 'Invalid base64 content', 'invalid_content');
    }
  }
  throw new HttpError(400, 'File content is required', 'content_required');
}

function assertFileSize(content: Uint8Array, text: boolean): void {
  const limit = text ? MAX_TEXT_BYTES : MAX_BINARY_BYTES;
  if (content.byteLength > limit) throw new HttpError(413, 'File is too large', 'file_too_large');
}

function assertFileProject(file: FileRecord, projectId: string): void {
  if (file.project_id !== projectId) throw new HttpError(404, 'File not found', 'file_not_found');
}

function requireAgentRevision(actor: AuthActor, request: FastifyRequest, currentRevision: string): void {
  if (actor.type !== 'agent') return;
  const supplied = request.headers['if-match'];
  if (!supplied) throw new HttpError(428, 'Agent mutations require If-Match with the current revision', 'revision_required');
  const normalized = supplied.replace(/^W\//, '').replaceAll('"', '');
  if (normalized !== currentRevision) {
    throw new HttpError(409, 'The file changed since it was read', 'revision_conflict', { currentRevision });
  }
}

function setEtag(reply: FastifyReply, revision: string): void {
  reply.header('ETag', `"${revision}"`);
}

function fileMetadata(file: FileRecord) {
  return {
    id: file.id,
    path: normalizeProjectPath(file.path),
    kind: file.kind,
    mimeType: file.mime_type,
    revision: file.revision_hash,
    size: Buffer.from(file.content).byteLength,
    createdAt: file.created_at,
    updatedAt: file.updated_at
  };
}

function fileResponse(file: FileRecord, content: Uint8Array, revision = file.revision_hash) {
  return {
    ...fileMetadata({ ...file, revision_hash: revision }),
    content: file.kind === 'text' ? Buffer.from(content).toString('utf8') : undefined,
    contentBase64: file.kind === 'binary' ? Buffer.from(content).toString('base64') : undefined
  };
}
