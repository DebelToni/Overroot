import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { config } from '../src/config.js';

it.skipIf(process.env.OVERROOT_TEST_DOCKER !== '1')('compiles a nested private source snapshot as the isolated Docker UID and reuses SyncTeX', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'overroot-docker-'));
  const previousContainer = config.dockerContainer;
  const previousFake = config.fakeCompiler;
  config.fakeCompiler = false;
  config.dockerContainer = `overroot-tectonic-test-${process.pid}`;
  const { app, context } = await buildApp({ databasePath: join(dir, 'test.sqlite3'), logger: false });
  try {
    const user = await context.auth.createUser('compiler-test', 'compiler-test-password', true);
    const project = context.projects.createImportedProject(user.id, 'Nested source', [
      { path: 'main.tex', content: Buffer.from('\\documentclass{article}\n\\begin{document}\\input{sections/deep/body}\\end{document}') },
      { path: 'sections/deep/body.tex', content: Buffer.from('Overroot compiler permission regression.') }
    ]);
    const actor = { type: 'user' as const, id: user.id, name: user.username };
    const body = context.projects.getFile(project.id, 'sections/deep/body.tex')!;
    const emit = context.events.emit.bind(context.events);
    const queuedEdit = vi.spyOn(context.events, 'emit').mockImplementation((projectId, event) => {
      emit(projectId, event);
      if (event.type === 'compile.queued') context.projects.renameFile(body.id, 'sections/deep/renamed.tex');
    });
    const job = await context.compiler.request(project, actor);
    queuedEdit.mockRestore();
    const deadline = Date.now() + 11 * 60_000;
    let result = context.compiler.get(job.id, project.id)!;
    while (['queued', 'compiling'].includes(result.status) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 250));
      result = context.compiler.get(job.id, project.id)!;
    }
    expect(result.status, result.error ?? result.log).toBe('succeeded');
    expect((await readFile(result.pdf_path!)).subarray(0, 5).toString()).toBe('%PDF-');
    expect(result.synctex_path).not.toBeNull();
    context.projects.renameFile(body.id, body.path);
    const cached = await context.compiler.request(project, actor);
    expect(cached.status).toBe('succeeded');
    expect(cached.source_hash).toBe(result.source_hash);
    expect(cached.synctex_path).toBe(result.synctex_path);
    expect((await readFile(cached.synctex_path!)).length).toBeGreaterThan(0);
  } finally {
    await app.close();
    try { execFileSync('docker', ['rm', '-f', config.dockerContainer], { stdio: 'ignore' }); }
    finally {
      config.dockerContainer = previousContainer;
      config.fakeCompiler = previousFake;
      await rm(dir, { recursive: true, force: true });
    }
  }
}, 12 * 60_000);
