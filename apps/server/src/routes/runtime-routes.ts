import { readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorIdentity } from '../actor.js';
import { audit } from '../audit.js';
import type { AppContext } from '../context.js';
import { HttpError } from '../errors.js';
import { normalizeProjectPath } from '../paths.js';
import { projectAccess, requireWrite } from '../permissions.js';
import { publicCompileJob } from '../compiler.js';
import { locateSyncTexFile } from '../synctex.js';

export function registerRuntimeRoutes(app: FastifyInstance, context: AppContext): void {
  app.post('/api/v1/projects/:hash/compile', async (request, reply) => {
    const actor = context.auth.require(request);
    const { hash } = z.object({ hash: z.string() }).parse(request.params);
    const access = projectAccess(context.db, actor, hash);
    requireWrite(access);
    const job = await context.compiler.request(access.project, actorIdentity(actor));
    audit(context.db, access.project.id, actorIdentity(actor), 'compile.requested', { jobId: job.id, sourceHash: job.source_hash });
    return reply.code(job.status === 'succeeded' ? 200 : 202).send({ job: publicCompileJob(job) });
  });

  app.get('/api/v1/projects/:hash/compile/latest', async (request) => {
    const actor = context.auth.require(request);
    const { hash } = z.object({ hash: z.string() }).parse(request.params);
    const access = projectAccess(context.db, actor, hash);
    const job = context.compiler.latest(access.project.id);
    const lastSuccessful = job?.status === 'succeeded' ? job : context.compiler.latestSuccessful(access.project.id);
    return {
      job: job ? publicCompileJob(job) : null,
      lastSuccessfulJob: lastSuccessful ? publicCompileJob(lastSuccessful) : null
    };
  });

  app.get('/api/v1/projects/:hash/compile/:jobId', async (request) => {
    const actor = context.auth.require(request);
    const params = z.object({ hash: z.string(), jobId: z.string().uuid() }).parse(request.params);
    const access = projectAccess(context.db, actor, params.hash);
    const job = context.compiler.get(params.jobId, access.project.id);
    if (!job) throw new HttpError(404, 'Compile job not found', 'compile_not_found');
    return { job: publicCompileJob(job) };
  });

  app.get('/api/v1/projects/:hash/compile/:jobId/pdf', async (request, reply) => {
    const actor = context.auth.require(request);
    const params = z.object({ hash: z.string(), jobId: z.string().uuid() }).parse(request.params);
    const access = projectAccess(context.db, actor, params.hash);
    const job = context.compiler.get(params.jobId, access.project.id);
    if (!job || job.status !== 'succeeded') throw new HttpError(404, 'Compiled PDF not found', 'pdf_not_found');
    const path = context.compiler.artifactPath(job, 'pdf');
    return reply
      .header('Cache-Control', 'private, max-age=31536000, immutable')
      .header('ETag', `"${job.source_hash}"`)
      .type('application/pdf')
      .send(await readFile(path));
  });

  app.get('/api/v1/projects/:hash/compile/:jobId/synctex', async (request, reply) => {
    const actor = context.auth.require(request);
    const params = z.object({ hash: z.string(), jobId: z.string().uuid() }).parse(request.params);
    const query = z.object({ path: z.string().min(1), line: z.coerce.number().int().min(1).max(1_000_000) }).parse(request.query);
    const access = projectAccess(context.db, actor, params.hash);
    const sourcePath = normalizeProjectPath(query.path);
    const source = context.projects.getFile(access.project.id, sourcePath);
    if (!source || source.kind !== 'text') throw new HttpError(404, 'Source file not found', 'file_not_found');
    const job = context.compiler.get(params.jobId, access.project.id);
    if (!job || job.status !== 'succeeded' || !job.synctex_path) {
      throw new HttpError(404, 'SyncTeX data not found', 'synctex_not_found');
    }
    const location = await locateSyncTexFile(context.compiler.artifactPath(job, 'synctex'), sourcePath, query.line);
    return reply
      .header('Cache-Control', 'private, max-age=31536000, immutable')
      .send({ source: { path: sourcePath, line: query.line, mappedLine: location.mappedLine }, highlights: location.highlights });
  });

  app.get('/api/v1/projects/:hash/pdf', async (request, reply) => {
    const actor = context.auth.require(request);
    const { hash } = z.object({ hash: z.string() }).parse(request.params);
    const access = projectAccess(context.db, actor, hash);
    const job = context.compiler.latestSuccessful(access.project.id);
    if (!job) throw new HttpError(404, 'No compiled PDF is available', 'pdf_not_found');
    const path = context.compiler.artifactPath(job, 'pdf');
    return reply
      .header('Cache-Control', 'private, no-cache')
      .header('ETag', `"${job.source_hash}"`)
      .header('X-Compile-Job', job.id)
      .type('application/pdf')
      .send(await readFile(path));
  });

  app.post('/api/v1/ws-ticket', async (request) => {
    const actor = context.auth.requireUser(request);
    const input = z
      .object({ projectHash: z.string(), channel: z.enum(['file', 'events']), fileId: z.string().uuid().optional() })
      .parse(request.body);
    const access = projectAccess(context.db, actor, input.projectHash);
    if (input.channel === 'file') {
      if (!access.canWrite) throw new HttpError(403, 'Only editors can open a collaborative editing socket', 'editor_required');
      if (!input.fileId) throw new HttpError(400, 'fileId is required for a file socket', 'file_required');
      const file = context.projects.getFileById(input.fileId);
      if (!file || file.project_id !== access.project.id || file.kind !== 'text') {
        throw new HttpError(404, 'Collaborative file not found', 'file_not_found');
      }
    }
    const ticket = context.tickets.create({
      channel: input.channel,
      projectId: access.project.id,
      projectHash: access.project.public_hash,
      fileId: input.fileId,
      actor: actorIdentity(actor),
      sessionHash: actor.sessionHash
    });
    const suffix =
      input.channel === 'file'
        ? `/ws/projects/${encodeURIComponent(access.project.public_hash)}/files/${encodeURIComponent(input.fileId!)}`
        : `/ws/projects/${encodeURIComponent(access.project.public_hash)}/events`;
    return { ticket: ticket.token, path: suffix, expiresAt: new Date(ticket.expiresAt).toISOString() };
  });
}
