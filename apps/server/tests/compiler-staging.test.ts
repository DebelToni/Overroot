import { seedUser } from './helpers.js';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { stageCompileSources } from '../src/compile-staging.js';
import { buildApp } from './helpers.js';
import { config } from '../src/config.js';

const io = vi.hoisted(() => ({
  beforeWrite: null as ((path: string) => Promise<void>) | null,
  directories: [] as string[],
  permissions: [] as Array<[string, number]>
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs,
    mkdir: async (...args: Parameters<typeof fs.mkdir>) => {
      io.directories.push(String(args[0]));
      return fs.mkdir(...args);
    },
    chmod: async (...args: Parameters<typeof fs.chmod>) => {
      io.permissions.push([String(args[0]), Number(args[1])]);
      return fs.chmod(...args);
    },
    writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
      await io.beforeWrite?.(String(args[0]));
      return fs.writeFile(...args);
    }
  };
});

const scratch: string[] = [];
afterEach(async () => {
  io.beforeWrite = null;
  io.directories.length = 0;
  io.permissions.length = 0;
  vi.restoreAllMocks();
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function temporary() {
  const dir = await mkdtemp(join(tmpdir(), 'overroot-staging-'));
  scratch.push(dir);
  return dir;
}

it('writes exact binary/text contents and prepares shared ancestors once with isolated-worker permissions', async () => {
  const dir = await temporary();
  const work = join(dir, 'job');
  const sources = [
    { path: 'main.tex', content: Buffer.from('\\input{sections/deep/body}') },
    { path: 'sections/deep/body.tex', content: Buffer.from('Requested content') },
    { path: 'sections/deep/data.bin', content: Buffer.from([0, 255, 128, 1]) }
  ];
  await stageCompileSources(work, sources);
  for (const source of sources) expect(await readFile(join(work, source.path))).toEqual(source.content);
  for (const directory of ['sections', 'sections/deep']) {
    expect(io.directories.filter(path => path === join(work, directory))).toHaveLength(1);
    expect(io.permissions.filter(([path, mode]) => path === join(work, directory) && mode === 0o755)).toHaveLength(1);
  }
  expect(io.permissions).toContainEqual([work, 0o755]);
  expect(io.permissions).toContainEqual([join(work, '.overroot-output'), 0o777]);
  for (const source of sources) expect(io.permissions).toContainEqual([join(work, source.path), 0o644]);
  if (process.platform !== 'win32') {
    expect((await stat(join(work, 'sections/deep'))).mode & 0o777).toBe(0o755);
    expect((await stat(join(work, sources[2]!.path))).mode & 0o777).toBe(0o644);
  }
});

it('bounds concurrent source writes and starts the next batch only after the current writes finish', async () => {
  const work = join(await temporary(), 'job');
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let writes = 0;
  io.beforeWrite = async () => { writes++; await blocked; };
  const pending = stageCompileSources(work, Array.from({ length: 25 }, (_, i) => ({ path: `${i}.tex`, content: Buffer.from(String(i)) })));
  try {
    await vi.waitFor(() => expect(writes).toBe(8));
  } finally { release(); }
  await pending;
  expect(writes).toBe(25);
});

it.each(['../escape.tex', 'nested/../../escape.tex', '.'])('rejects unsafe path %s before creating staging directories', async path => {
  const work = join(await temporary(), 'job');
  await expect(stageCompileSources(work, [{ path: 'valid.tex', content: Buffer.from('valid') }, { path, content: Buffer.from('unsafe') }]))
    .rejects.toThrow('Unsafe project path');
  await expect(stat(work)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('rejects an absolute path outside the work directory', async () => {
  const dir = await temporary();
  await expect(stageCompileSources(join(dir, 'job'), [{ path: resolve(dir, 'escape.tex'), content: Buffer.from('unsafe') }]))
    .rejects.toThrow('Unsafe project path');
});

it('drains an outstanding write before compiler cleanup and recovers the queue after staging fails', async () => {
  const dir = await temporary();
  const previous = config.fakeCompiler;
  config.fakeCompiler = true;
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let delayed = false;
  const { app, context } = await buildApp({ databasePath: join(dir, 'test.sqlite3'), logger: false });
  try {
    const user = seedUser(context.db, 'staging-test', true);
    const actor = { type: 'user' as const, id: user.id, name: user.username };
    const project = context.projects.createImportedProject(user.id, 'Staging recovery', [
      { path: 'main.tex', content: Buffer.from('First revision') },
      { path: 'delayed.tex', content: Buffer.from('Delayed write') }
    ]);
    io.beforeWrite = async path => {
      if (!path.includes(`${sep}jobs${sep}`)) return;
      if (path.endsWith(`${sep}main.tex`)) throw new Error('Controlled write failure');
      if (path.endsWith(`${sep}delayed.tex`)) { delayed = true; await blocked; }
    };
    const job = await context.compiler.request(project, actor);
    await vi.waitFor(() => expect(delayed).toBe(true));
    expect(context.compiler.get(job.id, project.id)?.status).toBe('compiling');
    expect((await stat(join(dir, 'jobs', job.id))).isDirectory()).toBe(true);
    release();
    await vi.waitFor(() => expect(context.compiler.get(job.id, project.id)?.status).toBe('failed'));
    await vi.waitFor(async () => expect(await stat(join(dir, 'jobs', job.id)).catch(() => null)).toBeNull());
    io.beforeWrite = null;
    context.projects.saveFile(context.projects.getFile(project.id, 'main.tex')!.id, Buffer.from('Next revision'), actor);
    const next = await context.compiler.request(project, actor);
    await context.compiler.close();
    expect(context.compiler.get(next.id, project.id)?.status).toBe('succeeded');
    const jobs = io.directories.filter(path => path.includes(`${sep}jobs${sep}`));
    expect(jobs.some(path => path.includes(next.id))).toBe(true);
  } finally {
    release();
    io.beforeWrite = null;
    await app.close();
    config.fakeCompiler = previous;
  }
});
