import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { config } from '../src/config.js';

const staged = vi.hoisted(() => new Map<string, Buffer>());
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...fs,
    writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
      await fs.writeFile(...args);
      const [path, data] = args;
      if (typeof path === 'string' && (typeof data === 'string' || data instanceof Uint8Array)) {
        staged.set(path, Buffer.from(data));
      }
    }
  };
});

it('stages the requested revision even when sources change before the queued job starts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'overroot-snapshot-'));
  const previousFake = config.fakeCompiler;
  config.fakeCompiler = true;
  staged.clear();
  const { app, context } = await buildApp({ databasePath: join(dir, 'test.sqlite3'), logger: false });
  try {
    const user = await context.auth.createUser('snapshot-test', 'snapshot-test-password', true);
    const actor = { type: 'user' as const, id: user.id, name: user.username };
    const sources = [
      { path: 'main.tex', content: Buffer.from('\\documentclass{article}\n\\begin{document}\\input{sections/body}\\end{document}') },
      { path: 'sections/body.tex', content: Buffer.from('The requested version.') },
      { path: 'assets/data.bin', content: Buffer.from([0, 255, 1, 128]) }
    ];
    const project = context.projects.createImportedProject(user.id, 'Snapshot test', sources);
    vi.spyOn(context.events, 'emit').mockImplementation((_projectId, event) => {
      if (event.type !== 'compile.queued') return;
      const main = context.projects.getFile(project.id, 'main.tex')!;
      const body = context.projects.getFile(project.id, 'sections/body.tex')!;
      context.projects.saveFile(main.id, Buffer.from('A later, broken revision.'), actor);
      context.projects.renameFile(body.id, 'sections/renamed.tex');
      context.projects.deleteFile(context.projects.getFile(project.id, 'assets/data.bin')!.id);
      context.projects.addFile(project.id, 'late.tex', Buffer.from('Added after compile was requested.'), undefined, actor);
    });
    const job = await context.compiler.request(project, actor);
    await context.compiler.close();
    const completed = context.compiler.get(job.id, project.id)!;
    expect(completed.status, completed.error ?? completed.log).toBe('succeeded');
    const workDir = join(dir, 'jobs', job.id);
    const actual = [...staged].filter(([path]) => path.startsWith(`${workDir}${sep}`) && !path.includes('.overroot-output'))
      .map(([path, content]) => ({ path: relative(workDir, path).split(sep).join('/'), content }));
    expect(actual.sort((a, b) => a.path.localeCompare(b.path)))
      .toEqual([...sources].sort((a, b) => a.path.localeCompare(b.path)));
    expect(Buffer.from(context.projects.getFile(project.id, 'main.tex')!.content).toString()).toBe('A later, broken revision.');
  } finally {
    await app.close();
    vi.restoreAllMocks();
    config.fakeCompiler = previousFake;
    await rm(dir, { recursive: true, force: true });
  }
});
