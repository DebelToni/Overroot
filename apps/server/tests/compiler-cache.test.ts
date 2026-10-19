import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { config } from '../src/config.js';
import type { AppContext } from '../src/context.js';

const cacheIo = vi.hoisted(() => ({
  beforeOpen: null as ((path: string) => Promise<void>) | null,
  writes: new Map<string, Buffer>()
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    await cacheIo.beforeOpen?.(String(args[0]));
    return fs.open(...args);
  }, writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
    await fs.writeFile(...args);
    if (typeof args[0] === 'string' && (typeof args[1] === 'string' || args[1] instanceof Uint8Array)) {
      cacheIo.writes.set(args[0], Buffer.from(args[1]));
    }
  } };
});

const previous = { fake: config.fakeCompiler, jobs: config.compileMaxJobs };
let app: Awaited<ReturnType<typeof buildApp>>['app'];
let context: AppContext;
let dir: string;

beforeEach(() => {
  config.fakeCompiler = true;
  config.compileMaxJobs = 1;
});
afterEach(async () => {
  cacheIo.beforeOpen = null;
  cacheIo.writes.clear();
  if (app) await app.close();
  vi.restoreAllMocks();
  config.fakeCompiler = previous.fake;
  config.compileMaxJobs = previous.jobs;
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function setup() {
  dir = await mkdtemp(join(tmpdir(), 'overroot-cache-'));
  ({ app, context } = await buildApp({ databasePath: join(dir, 'test.sqlite3'), logger: false }));
  const user = await context.auth.createUser('cache-test', 'cache-test-password', true);
  const actor = { type: 'user' as const, id: user.id, name: user.username };
  const project = context.projects.createImportedProject(user.id, 'Cache recovery', [
    { path: 'main.tex', content: Buffer.from('Frozen revision') }
  ]);
  const request = () => context.compiler.request(project, actor);
  const first = await request();
  await vi.waitFor(() => expect(context.compiler.get(first.id, project.id)?.status).toBe('succeeded'));
  // A completed job's final staging cleanup still owns its admission slot.
  await vi.waitFor(async () => expect((await request()).status).toBe('succeeded'));
  const original = context.compiler.get(first.id, project.id)!;
  const pdf = await readFile(original.pdf_path!);
  const events = vi.spyOn(context.events, 'emit');
  return { request, project, actor, original, pdf, events };
}

it.each(['', '%PD', 'broken cache artifact', '%PDF-1.7\ntruncated'])('recompiles a corrupt cached PDF %j and reuses the repaired output', async corruption => {
  const h = await setup();
  await writeFile(h.original.pdf_path!, corruption);
  const repaired = await h.request();
  expect(repaired.status).toBe('queued');
  expect(h.events.mock.calls.some(([, event]) => event.type === 'compile.ready' && event.cached === true)).toBe(false);
  await vi.waitFor(() => expect(context.compiler.get(repaired.id, h.project.id)?.status).toBe('succeeded'));
  expect(await readFile(h.original.pdf_path!)).toEqual(h.pdf);
  const cached = await vi.waitFor(() => h.request());
  expect(cached.status).toBe('succeeded');
  expect(h.events.mock.calls.some(([, event]) => event.type === 'compile.ready' && event.cached === false)).toBe(true);
  expect(h.events.mock.calls.at(-1)?.[1]).toMatchObject({ type: 'compile.ready', cached: true });
});

it('recompiles the frozen snapshot when a cached PDF disappears between stat and validation', async () => {
  const h = await setup();
  let removed = false;
  cacheIo.beforeOpen = async path => {
    if (path !== h.original.pdf_path || removed) return;
    removed = true;
    await rm(path);
    const main = context.projects.getFile(h.project.id, 'main.tex')!;
    context.projects.saveFile(main.id, Buffer.from('A later revision'), h.actor);
  };
  const repaired = await h.request();
  expect(removed).toBe(true);
  expect(repaired.status).toBe('queued');
  expect(repaired.source_hash).toBe(h.original.source_hash);
  await vi.waitFor(() => expect(context.compiler.get(repaired.id, h.project.id)?.status).toBe('succeeded'));
  expect(await readFile(h.original.pdf_path!)).toEqual(h.pdf);
  expect(cacheIo.writes.get(join(dir, 'jobs', repaired.id, 'main.tex'))?.toString()).toBe('Frozen revision');
  expect(Buffer.from(context.projects.getFile(h.project.id, 'main.tex')!.content).toString()).toBe('A later revision');
});

it('reports a current cache validation I/O failure and releases admission for a retry', async () => {
  const h = await setup();
  cacheIo.beforeOpen = async path => {
    if (path === h.original.pdf_path) throw Object.assign(new Error('Controlled cache read failure'), { code: 'EACCES' });
  };
  await expect(h.request()).rejects.toThrow('Controlled cache read failure');
  cacheIo.beforeOpen = null;
  expect((await h.request()).status).toBe('succeeded');
});
