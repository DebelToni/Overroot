import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { config } from '../src/config.js';
import type { AppContext } from '../src/context.js';

const staging = vi.hoisted(() => ({ wait: null as (() => Promise<void>) | null, cacheWait: null as (() => Promise<void>) | null }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs, mkdir: async (...args: Parameters<typeof fs.mkdir>) => {
    if (typeof args[0] === 'string' && args[0].includes(`${sep}jobs${sep}`) && args[0].endsWith('.overroot-output')) {
      await staging.wait?.();
    }
    return fs.mkdir(...args);
  }, stat: async (...args: Parameters<typeof fs.stat>) => {
    if (typeof args[0] === 'string' && args[0].includes(`${sep}compile-cache${sep}`) && args[0].endsWith('.pdf')) {
      await staging.cacheWait?.();
    }
    return fs.stat(...args);
  } };
});

const previous = { fake: config.fakeCompiler, jobs: config.compileMaxJobs, bytes: config.compileMaxSnapshotBytes };
let context: AppContext;
let app: Awaited<ReturnType<typeof buildApp>>['app'];
let dir: string;
let releaseStaging: () => void;
let releaseCache: () => void;

beforeEach(() => {
  config.fakeCompiler = true;
  config.compileMaxJobs = 2;
  config.compileMaxSnapshotBytes = 1024;
  const blocked = new Promise<void>(resolve => { releaseStaging = resolve; });
  staging.wait = () => blocked;
  releaseCache = () => {};
});
afterEach(async () => {
  releaseStaging();
  releaseCache();
  staging.wait = null;
  staging.cacheWait = null;
  if (app) await app.close();
  vi.restoreAllMocks();
  config.fakeCompiler = previous.fake;
  config.compileMaxJobs = previous.jobs;
  config.compileMaxSnapshotBytes = previous.bytes;
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function setup() {
  dir = await mkdtemp(join(tmpdir(), 'overroot-admission-'));
  ({ app, context } = await buildApp({ databasePath: join(dir, 'test.sqlite3'), logger: false }));
  const user = await context.auth.createUser('admission-test', 'admission-test-password', true);
  const actor = { type: 'user' as const, id: user.id, name: user.username };
  const project = context.projects.createImportedProject(user.id, 'Bounded compile', [
    { path: 'main.tex', content: Buffer.from('Revision A') },
    { path: 'assets/data.bin', content: Buffer.alloc(64, 42) }
  ]);
  const readSources = vi.spyOn(context.projects, 'compileSources');
  const revision = (name: string) => context.projects.saveFile(context.projects.getFile(project.id, 'main.tex')!.id, Buffer.from(`Revision ${name}`), actor);
  const request = () => context.compiler.request(project, actor);
  return { project, actor, request, revision, readSources };
}

async function finished(id: string, projectId: string, status = 'succeeded') {
  await vi.waitFor(() => expect(context.compiler.get(id, projectId)?.status).toBe(status));
}

it('bounds distinct queued jobs before loading snapshots and releases capacity when they finish', async () => {
  const h = await setup();
  const first = await h.request();
  h.revision('B');
  const second = await h.request();
  h.revision('C');
  await expect(h.request()).rejects.toMatchObject({ statusCode: 429, code: 'compile_queue_full' });
  expect(h.readSources).toHaveBeenCalledTimes(2);
  expect(context.db.get<{ count: number }>('SELECT count(*) AS count FROM compile_jobs')?.count).toBe(2);
  releaseStaging();
  await finished(first.id, h.project.id);
  await finished(second.id, h.project.id);
  const third = await h.request();
  await finished(third.id, h.project.id);
});

it('bounds retained source bytes independently of the job count', async () => {
  config.compileMaxJobs = 10;
  config.compileMaxSnapshotBytes = 148; // Two revisions, each with 10 text and 64 asset bytes.
  const h = await setup();
  const first = await h.request();
  h.revision('B');
  const second = await h.request();
  h.revision('C');
  await expect(h.request()).rejects.toMatchObject({ statusCode: 429, code: 'compile_queue_full' });
  expect(h.readSources).toHaveBeenCalledTimes(2);
  releaseStaging();
  await finished(first.id, h.project.id);
  await finished(second.id, h.project.id);
  const next = await h.request();
  await finished(next.id, h.project.id);
});

it('rejects an oversized snapshot before loading any source blobs', async () => {
  config.compileMaxSnapshotBytes = 73;
  const h = await setup();
  await expect(h.request()).rejects.toMatchObject({ statusCode: 413, code: 'compile_snapshot_too_large' });
  expect(h.readSources).not.toHaveBeenCalled();
});

it('coalesces simultaneous and in-flight duplicates and releases cached-hit reservations', async () => {
  config.compileMaxJobs = 1;
  const h = await setup();
  const [first, simultaneous] = await Promise.all([h.request(), h.request()]);
  expect(simultaneous.id).toBe(first.id);
  expect((await h.request()).id).toBe(first.id);
  expect(h.readSources).toHaveBeenCalledOnce();
  releaseStaging();
  await finished(first.id, h.project.id);
  // The success record can be visible while staging cleanup is still draining.
  expect((await vi.waitFor(() => h.request())).status).toBe('succeeded');
  h.revision('B');
  const next = await h.request();
  await finished(next.id, h.project.id);
});

it('releases capacity after compilation fails', async () => {
  config.compileMaxJobs = 1;
  const h = await setup();
  staging.wait = async () => { throw new Error('Controlled staging failure'); };
  const failed = await h.request();
  await finished(failed.id, h.project.id, 'failed');
  staging.wait = null;
  h.revision('B');
  const next = await h.request();
  await finished(next.id, h.project.id);
});

it('releases capacity if loading the snapshot fails before enqueueing', async () => {
  config.compileMaxJobs = 1;
  const h = await setup();
  h.readSources.mockImplementationOnce(() => { throw new Error('Controlled source read failure'); });
  await expect(h.request()).rejects.toThrow('Controlled source read failure');
  releaseStaging();
  const next = await h.request();
  await finished(next.id, h.project.id);
});

it('releases capacity if recording the queued job fails', async () => {
  config.compileMaxJobs = 1;
  const h = await setup();
  const run = context.db.run.bind(context.db);
  const failedInsert = vi.spyOn(context.db, 'run').mockImplementation((sql, ...parameters) => {
    if (sql.includes('INSERT INTO compile_jobs')) throw new Error('Controlled insert failure');
    return run(sql, ...parameters);
  });
  await expect(h.request()).rejects.toThrow('Controlled insert failure');
  failedInsert.mockRestore();
  releaseStaging();
  const next = await h.request();
  await finished(next.id, h.project.id);
});

it('shares the queue limit across projects', async () => {
  config.compileMaxJobs = 1;
  const h = await setup();
  const first = await h.request();
  const other = context.projects.createImportedProject(h.project.owner_id, 'Another project', [
    { path: 'main.tex', content: Buffer.from('Another revision') }
  ]);
  await expect(context.compiler.request(other, h.actor)).rejects.toMatchObject({ statusCode: 429, code: 'compile_queue_full' });
  expect(h.readSources).toHaveBeenCalledOnce();
  releaseStaging();
  await finished(first.id, h.project.id);
  const next = await vi.waitFor(() => context.compiler.request(other, h.actor));
  await finished(next.id, other.id);
});

it('does not enqueue a request still flushing when shutdown begins', async () => {
  const h = await setup();
  let finishFlush!: () => void;
  vi.spyOn(context.collaboration, 'flushProject').mockReturnValue(new Promise(resolve => { finishFlush = resolve; }));
  const pending = h.request();
  await context.compiler.close();
  finishFlush();
  await expect(pending).rejects.toMatchObject({ statusCode: 503, code: 'compiler_unavailable' });
  expect(h.readSources).not.toHaveBeenCalled();
});

it('drains an admission waiting on cache I/O before finishing shutdown', async () => {
  const h = await setup();
  const blocked = new Promise<void>(resolve => { releaseCache = resolve; });
  staging.cacheWait = () => blocked;
  const pending = h.request();
  await vi.waitFor(() => expect(h.readSources).toHaveBeenCalledOnce());
  const rejected = expect(pending).rejects.toMatchObject({ statusCode: 503, code: 'compiler_unavailable' });
  const closing = context.compiler.close();
  releaseCache();
  await rejected;
  await closing;
  expect(context.db.get<{ count: number }>('SELECT count(*) AS count FROM compile_jobs')?.count).toBe(0);
});
