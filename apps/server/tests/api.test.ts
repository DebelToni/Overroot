import { seedUser, login, humanHeaders } from './helpers.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from './helpers.js';
import type { AppContext } from '../src/context.js';
import { config } from '../src/config.js';

interface Harness {
  app: FastifyInstance;
  context: AppContext;
  dir: string;
  adminToken: string;
}

let harness: Harness | undefined;

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'overroot-test-'));
  config.fakeCompiler = true;
  config.publicUrl = 'https://overroot.toni.foo';
  const built = await buildApp({ databasePath: join(dir, 'test.sqlite3'), logger: false });
  const admin = seedUser(built.context.db, 'admin', true);
  const adminToken = login(built.context.auth, admin);
  harness = { app: built.app, context: built.context, dir, adminToken };
});

afterEach(async () => {
  if (!harness) return;
  await harness.app.close();
  await rm(harness.dir, { recursive: true, force: true });
  harness = undefined;
});

function bearer(token: string) {
  return token.startsWith('ul_agent_') ? { authorization: `Bearer ${token}` } : humanHeaders(token);
}

describe('Overroot API', () => {
  it('reports the canonical public URL and API contract', async () => {
    const { app } = harness!;
    const status = await app.inject({ method: 'GET', url: '/api/v1/status' });
    expect(status.statusCode).toBe(200);
    expect(status.json().publicUrl).toBe('https://overroot.toni.foo');
    expect(status.json()).not.toHaveProperty('discoveryUrl');
    const { openapi } = await import('../src/openapi.js');
    expect(openapi.servers[0].url).toBe('https://overroot.toni.foo');
    expect(openapi.externalDocs.url).toBe('https://overroot.toni.foo/agent-guide.md');
    expect(openapi.components.schemas.Status.required).toContain('publicUrl');
    expect(JSON.stringify(openapi).toLowerCase()).not.toContain('discovery');
  });

  it('preserves project sharing for explicit identity projections', async () => {
    const { app, context, adminToken } = harness!;
    const friend = seedUser(context.db, 'friend', false);
    const friendToken = login(context.auth, friend);

    const created = await createProject(app, adminToken);
    const shared = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${created.hash}/members`,
      headers: bearer(adminToken),
      payload: { username: 'friend', role: 'editor' }
    });
    expect(shared.statusCode).toBe(201);

    const friendProjects = await app.inject({ method: 'GET', url: '/api/v1/projects', headers: bearer(friendToken) });
    expect(friendProjects.statusCode).toBe(200);
    expect(friendProjects.json().projects[0]).toMatchObject({ hash: created.hash, role: 'editor' });
  });

  it('gives agents project-scoped revision-safe file CRUD', async () => {
    const { app, adminToken } = harness!;
    const project = await createProject(app, adminToken);
    const credential = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.hash}/agents`,
      headers: bearer(adminToken),
      payload: { name: 'Pi test agent' }
    });
    expect(credential.statusCode).toBe(201);
    expect(credential.json().access).toMatchObject({
      link: 'https://overroot.toni.foo',
      guide: 'https://overroot.toni.foo/agent-guide.md',
      projectHash: project.hash
    });
    const agentPassword = credential.json().access.password as string;

    const context = await app.inject({ method: 'GET', url: '/api/v1/agent/context', headers: bearer(agentPassword) });
    expect(context.statusCode).toBe(200);
    expect(context.json().project.hash).toBe(project.hash);

    const tree = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${project.hash}/files`,
      headers: bearer(agentPassword)
    });
    const main = tree.json().files.find((file: any) => file.path === 'main.tex');
    expect(main).toBeTruthy();

    const stale = await app.inject({
      method: 'PUT',
      url: `/api/v1/projects/${project.hash}/files/${main.id}`,
      headers: { ...bearer(agentPassword), 'if-match': 'stale' },
      payload: { content: '\\documentclass{article}\\begin{document}Nope\\end{document}' }
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.details.currentRevision).toBe(main.revision);

    const content = '\\documentclass{article}\n\\begin{document}\nUpdated by agent.\n\\end{document}\n';
    const updated = await app.inject({
      method: 'PUT',
      url: `/api/v1/projects/${project.hash}/files/${main.id}`,
      headers: { ...bearer(agentPassword), 'if-match': main.revision },
      payload: { content }
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().file.content).toBe(content);

    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.hash}/files`,
      headers: bearer(agentPassword),
      payload: { path: 'sections/intro.tex', content: 'Hello' }
    });
    expect(created.statusCode).toBe(201);

    const project2 = await createProject(app, adminToken, 'Other project');
    const denied = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${project2.hash}/files`,
      headers: bearer(agentPassword)
    });
    expect(denied.statusCode).toBe(404);
  });

  it('updates the entry file on rename and requires If-Match for agent restores', async () => {
    const { app, adminToken } = harness!;
    const project = await createProject(app, adminToken);
    const credential = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.hash}/agents`,
      headers: bearer(adminToken),
      payload: { name: 'Revision agent' }
    });
    const agentPassword = credential.json().access.password as string;
    const agentHeaders = bearer(agentPassword);
    const tree = await app.inject({ method: 'GET', url: `/api/v1/projects/${project.hash}/files`, headers: agentHeaders });
    const main = tree.json().files.find((file: any) => file.path === 'main.tex');

    const renamed = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${project.hash}/files/${main.id}`,
      headers: { ...agentHeaders, 'if-match': main.revision },
      payload: { path: 'paper.tex' }
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().file.revision).not.toBe(main.revision);
    const metadata = await app.inject({ method: 'GET', url: `/api/v1/projects/${project.hash}`, headers: agentHeaders });
    expect(metadata.json().project.entryFile).toBe('paper.tex');

    const staleRename = await app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${project.hash}/files/${main.id}`,
      headers: { ...agentHeaders, 'if-match': main.revision },
      payload: { path: 'stale.tex' }
    });
    expect(staleRename.statusCode).toBe(409);

    const revisions = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${project.hash}/files/${main.id}/revisions`,
      headers: agentHeaders
    });
    const revisionId = revisions.json().revisions.at(-1).id;
    const restoreWithoutRevision = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.hash}/files/${main.id}/revisions/${revisionId}/restore`,
      headers: agentHeaders
    });
    expect(restoreWithoutRevision.statusCode).toBe(428);
  });

  it('lets editors compile their chosen source without changing a project default', async () => {
    const { app, context, adminToken } = harness!;
    const editor = seedUser(context.db, 'compile-editor', false);
    const editorToken = login(context.auth, editor);
    const project = await createProject(app, adminToken);
    const base = `/api/v1/projects/${project.hash}`;
    expect((await app.inject({ method: 'POST', url: `${base}/members`, headers: bearer(adminToken), payload: { username: 'compile-editor', role: 'editor' } })).statusCode).toBe(201);
    const source = await app.inject({ method: 'POST', url: `${base}/files`, headers: bearer(editorToken), payload: { path: 'chapters/other.tex', content: '\\documentclass{article}\\begin{document}Other\\end{document}' } });
    expect(source.statusCode).toBe(201);
    const compile = (filePath: string) => app.inject({ method: 'POST', url: `${base}/compile`, headers: bearer(editorToken), payload: { filePath } });
    const first = await compile('chapters/other.tex');
    expect(first.statusCode).toBe(202);
    expect(first.json().job.entryFile).toBe('chapters/other.tex');
    await vi.waitFor(() => expect(context.compiler.get(first.json().job.id, context.projects.getProjectByHash(project.hash)!.id)?.status).toBe('succeeded'));
    const cached = await compile('chapters/other.tex');
    expect(cached.statusCode).toBe(200);
    expect(cached.json().job.sourceHash).toBe(first.json().job.sourceHash);
    const original = await compile('main.tex');
    expect(original.statusCode).toBe(202);
    expect(original.json().job.sourceHash).not.toBe(first.json().job.sourceHash);
    expect((await app.inject({ method: 'GET', url: base, headers: bearer(editorToken) })).json().project.entryFile).toBe('main.tex');
    for (const filePath of ['missing.tex', '../outside.tex', 'chapters/other.pdf']) {
      const invalid = await compile(filePath);
      expect(invalid.statusCode).toBe(400);
    }
    const deleted = await app.inject({ method: 'DELETE', url: `${base}/files/${source.json().file.id}`, headers: bearer(editorToken) });
    expect(deleted.statusCode).toBe(204);
    expect((await compile('chapters/other.tex')).statusCode).toBe(400);
    const tree = await app.inject({ method: 'GET', url: `${base}/files`, headers: bearer(editorToken) });
    const main = tree.json().files.find((file: any) => file.path === 'main.tex');
    expect((await app.inject({ method: 'DELETE', url: `${base}/files/${main.id}`, headers: bearer(editorToken) })).statusCode).toBe(204);
  });

  it('compiles, caches, and serves authenticated PDFs', async () => {
    const { app, adminToken, context } = harness!;
    const project = await createProject(app, adminToken);
    const latestUrl = `/api/v1/projects/${project.hash}/compile/latest`;
    const empty = await app.inject({ method: 'GET', url: latestUrl, headers: bearer(adminToken) });
    expect(empty.json()).toEqual({ job: null, lastSuccessfulJob: null });
    const first = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.hash}/compile`,
      headers: bearer(adminToken)
    });
    expect(first.statusCode).toBe(202);
    const id = first.json().job.id as string;

    let job: any;
    for (let index = 0; index < 50; index += 1) {
      job = context.compiler.get(id, context.projects.getProjectByHash(project.hash)!.id);
      if (job?.status === 'succeeded') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(job.status).toBe('succeeded');

    expect(context.compiler.artifactPath(job, 'pdf')).toBe(job.pdf_path);
    for (const path of [
      join(harness!.dir, 'compile-cache'),
      join(harness!.dir, 'compile-cache-neighbor', 'outside.pdf'),
      join(harness!.dir, 'compile-cache', '..', 'outside.pdf')
    ]) {
      expect(() => context.compiler.artifactPath({ ...job, pdf_path: path }, 'pdf')).toThrow('Artifact not found');
    }

    const pdf = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${project.hash}/compile/${id}/pdf`,
      headers: bearer(adminToken)
    });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');

    const synctexPath = join(harness!.dir, 'compile-cache', `${job.source_hash}.synctex.gz`);
    await writeFile(synctexPath, gzipSync(`SyncTeX Version:1\nInput:1:/work/job/main.tex\nMagnification:1000\nUnit:1\nX Offset:0\nY Offset:0\nContent:\n{1\n(1,10:6578176,13156352:13156352,657818,131564\nh1,10:6578176,13156352:13156352,0,0\n)\n}1\n`));
    context.db.run('UPDATE compile_jobs SET synctex_path = ? WHERE id = ?', synctexPath, id);
    const sourceLocation = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${project.hash}/compile/${id}/synctex?path=main.tex&line=10`,
      headers: bearer(adminToken)
    });
    expect(sourceLocation.statusCode).toBe(200);
    expect(sourceLocation.json()).toEqual({
      source: { path: 'main.tex', line: 10, mappedLine: 10 },
      highlights: [{ page: 1, x: 100, y: 190, width: 200, height: 12 }]
    });

    const cached = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.hash}/compile`,
      headers: bearer(adminToken)
    });
    expect(cached.statusCode).toBe(200);
    expect(cached.json().job.status).toBe('succeeded');
    expect(cached.json().job.hasSynctex).toBe(true);
    const cachedLocation = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${project.hash}/compile/${cached.json().job.id}/synctex?path=main.tex&line=10`,
      headers: bearer(adminToken)
    });
    expect(cachedLocation.statusCode).toBe(200);
    expect(cachedLocation.json()).toEqual(sourceLocation.json());

    const failedId = '00000000-0000-4000-8000-000000000001';
    context.db.run(`INSERT INTO compile_jobs
      (id, project_id, source_hash, status, entry_file, log, error,
       requested_by_type, requested_by_id, requested_by_name, created_at, finished_at)
      SELECT ?, project_id, 'failed-revision', 'failed', entry_file, 'Invalid TeX', 'Invalid TeX',
       requested_by_type, requested_by_id, requested_by_name, ?, ? FROM compile_jobs WHERE id = ?`,
    failedId, new Date(Date.now() + 1000).toISOString(), new Date().toISOString(), id);
    const latest = await app.inject({ method: 'GET', url: latestUrl, headers: bearer(adminToken) });
    expect(latest.json().job).toMatchObject({ id: failedId, status: 'failed', hasPdf: false });
    expect(latest.json().lastSuccessfulJob).toMatchObject({ id: cached.json().job.id, status: 'succeeded', hasPdf: true, hasSynctex: true });
    const lastGood = await app.inject({ method: 'GET', url: `/api/v1/projects/${project.hash}/pdf`, headers: bearer(adminToken) });
    expect(lastGood.statusCode).toBe(200);
    expect(lastGood.rawPayload).toEqual(pdf.rawPayload);
    const other = await createProject(app, adminToken, 'Uncompiled project');
    const isolated = await app.inject({ method: 'GET', url: `/api/v1/projects/${other.hash}/compile/latest`, headers: bearer(adminToken) });
    expect(isolated.json()).toEqual({ job: null, lastSuccessfulJob: null });
  });
});

async function createProject(app: FastifyInstance, token: string, name = 'Test paper') {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/projects',
    headers: bearer(token),
    payload: { name, template: 'article' }
  });
  expect(response.statusCode).toBe(201);
  return response.json().project as { hash: string; name: string };
}
