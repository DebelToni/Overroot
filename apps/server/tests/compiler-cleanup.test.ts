import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { config } from '../src/config.js';
import type { AppContext } from '../src/context.js';

type Failure = 'pdf-copy' | 'invalid-pdf' | 'footer-read' | 'log-write' | 'pdf-rename' | 'log-rename' | 'synctex-copy' | 'synctex-rename';
const io = vi.hoisted(() => ({ failure: null as Failure | null, injected: false, closes: 0 }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  function fail(type: Failure, path: string) {
    if (io.failure === type && !io.injected && path.includes(`${sep}compile-cache${sep}`)) {
      io.injected = true;
      throw new Error(`Controlled ${type} failure`);
    }
  }
  return { ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      const path = String(args[0]);
      if (io.failure !== 'footer-read' || !path.endsWith('.tmp')) return handle;
      return {
        read: (buffer: Buffer, offset: number, length: number, position: number) => {
          if (position >= 5) fail('footer-read', path);
          return handle.read(buffer, offset, length, position);
        },
        stat: () => handle.stat(),
        close: async () => { io.closes++; await handle.close(); }
      };
    },
    copyFile: async (...args: Parameters<typeof fs.copyFile>) => {
      await fs.copyFile(...args);
      const destination = String(args[1]);
      if (destination.includes('.pdf.') && destination.endsWith('.tmp')) {
        if (io.failure === 'invalid-pdf' && !io.injected) {
          io.injected = true;
          await fs.writeFile(destination, 'Invalid compiler output');
        }
        fail('pdf-copy', destination);
      }
      if (destination.includes('.synctex.gz.') && destination.endsWith('.tmp')) fail('synctex-copy', destination);
    },
    writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
      await fs.writeFile(...args);
      const path = String(args[0]);
      if (path.includes(`${sep}jobs${sep}`) && path.endsWith(`${sep}.overroot-output${sep}main.pdf`)) {
        // The fake compiler normally has no SyncTeX. Supply an artifact so the
        // real publication path can exercise copy/rename failures for it too.
        await fs.writeFile(join(dirname(path), 'main.synctex.gz'), Buffer.from('SyncTeX publication fixture'));
      }
      if (path.includes('.log.') && path.endsWith('.tmp')) fail('log-write', path);
    },
    rename: async (...args: Parameters<typeof fs.rename>) => {
      const destination = String(args[1]);
      if (destination.endsWith('.pdf')) fail('pdf-rename', destination);
      if (destination.endsWith('.log')) fail('log-rename', destination);
      if (destination.endsWith('.synctex.gz')) fail('synctex-rename', destination);
      return fs.rename(...args);
    }
  };
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
  io.failure = null;
  io.injected = false;
  io.closes = 0;
  if (app) await app.close();
  config.fakeCompiler = previous.fake;
  config.compileMaxJobs = previous.jobs;
  if (dir) await rm(dir, { recursive: true, force: true });
});

it.each<Failure>(['pdf-copy', 'invalid-pdf', 'footer-read', 'log-write', 'pdf-rename', 'log-rename', 'synctex-copy', 'synctex-rename'])(
  'cleans only owned temporary artifacts after %s and recovers the queue', async failure => {
    dir = await mkdtemp(join(tmpdir(), 'overroot-cleanup-'));
    ({ app, context } = await buildApp({ databasePath: join(dir, 'test.sqlite3'), logger: false }));
    const user = await context.auth.createUser('cleanup-test', 'cleanup-test-password', true);
    const actor = { type: 'user' as const, id: user.id, name: user.username };
    const project = context.projects.createImportedProject(user.id, 'Cleanup recovery', [
      { path: 'main.tex', content: Buffer.from('First revision') }
    ]);
    const cacheDir = join(dir, 'compile-cache');
    const unownedTemp = join(cacheDir, 'another-job.pdf.keep.tmp');
    await writeFile(unownedTemp, 'Another pending job owns this file');
    io.failure = failure;
    const failed = await context.compiler.request(project, actor);
    await vi.waitFor(() => expect(context.compiler.get(failed.id, project.id)?.status).toBe('failed'));
    expect(io.injected).toBe(true);
    if (failure === 'footer-read') expect(io.closes).toBe(1);
    expect(context.compiler.get(failed.id, project.id)?.error).toContain(
      failure === 'invalid-pdf' ? 'Compiler produced an invalid PDF' : `Controlled ${failure} failure`
    );
    await vi.waitFor(async () => {
      expect((await readdir(cacheDir)).filter(path => path.endsWith(`.${failed.id}.tmp`))).toEqual([]);
      expect(await readdir(join(dir, 'jobs'))).toEqual([]);
    });
    expect(await readFile(unownedTemp, 'utf8')).toBe('Another pending job owns this file');
    // If publication advanced past the PDF rename, cleanup must preserve that
    // final cache artifact, rather than deleting a path shared by other jobs.
    if (['log-rename', 'synctex-copy', 'synctex-rename'].includes(failure)) {
      expect((await readFile(join(cacheDir, `${failed.source_hash}.pdf`))).subarray(0, 5).toString()).toBe('%PDF-');
    }
    io.failure = null;
    context.projects.saveFile(context.projects.getFile(project.id, 'main.tex')!.id, Buffer.from('Retry revision'), actor);
    const retry = await vi.waitFor(() => context.compiler.request(project, actor));
    await context.compiler.close();
    const complete = context.compiler.get(retry.id, project.id)!;
    expect(complete.status, complete.error ?? complete.log).toBe('succeeded');
    expect((await readFile(complete.pdf_path!)).subarray(0, 5).toString()).toBe('%PDF-');
    expect((await stat(complete.synctex_path!)).isFile()).toBe(true);
    expect((await readdir(cacheDir)).filter(path => path.endsWith(`.${retry.id}.tmp`))).toEqual([]);
  }
);
