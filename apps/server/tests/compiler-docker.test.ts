import { seedUser } from './helpers.js';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { buildApp } from './helpers.js';
import { config } from '../src/config.js';

it.skipIf(process.env.OVERROOT_TEST_DOCKER !== '1')('replaces a legacy worker, reaps orphaned processes, compiles private sources and reuses SyncTeX', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'overroot-docker-'));
  const previousContainer = config.dockerContainer;
  const previousFake = config.fakeCompiler;
  config.fakeCompiler = false;
  config.dockerContainer = `overroot-tectonic-test-${process.pid}`;
  const { app, context } = await buildApp({ databasePath: join(dir, 'test.sqlite3'), logger: false });
  try {
    // Match every existing worker requirement except init, reproducing pre-fix containers.
    execFileSync('docker', ['build', '-t', config.dockerImage, config.dockerfileDir], { timeout: 10 * 60_000 });
    const legacyId = execFileSync('docker', [
      'run', '-d', '--name', config.dockerContainer, '--restart', 'unless-stopped',
      '--cpus=2', '--memory=1g', '--pids-limit=128', '--cap-drop=ALL',
      '--security-opt=no-new-privileges', '--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m',
      '-v', 'overroot-tectonic-cache:/var/cache/tectonic',
      '-v', `${await realpath(join(dir, 'jobs'))}:/work:rw`, config.dockerImage
    ], { encoding: 'utf8', timeout: 30_000 }).trim();
    const user = seedUser(context.db, 'compiler-test', true);
    const modules = Array.from({ length: 20 }, (_, i) => ({
      path: `sections/deep/chapter-${i % 4}/part-${i}.tex`,
      content: Buffer.from(`Module ${i} is readable by the isolated compiler.\n\n`)
    }));
    const includes = modules.map(file => `\\input{${file.path}}`).join('\n');
    const project = context.projects.createImportedProject(user.id, 'Nested source', [
      { path: 'main.tex', content: Buffer.from(`\\documentclass{article}\n\\begin{document}\\input{sections/deep/body}\n${includes}\n\\end{document}`) },
      { path: 'sections/deep/body.tex', content: Buffer.from('Overroot compiler permission regression.') },
      ...modules
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
    const worker = JSON.parse(execFileSync('docker', ['inspect', config.dockerContainer], { encoding: 'utf8', timeout: 10_000 }))[0];
    expect(worker.Id).not.toBe(legacyId);
    expect(worker.HostConfig.Init).toBe(true);
    // The shell exits first; its child is adopted by PID 1 and must be reaped after exit.
    const orphanPid = execFileSync('docker', [
      'exec', config.dockerContainer, 'sh', '-c', 'sleep 1 </dev/null >/dev/null 2>&1 & echo $!'
    ], { encoding: 'utf8', timeout: 10_000 }).trim();
    expect(orphanPid).toMatch(/^\d+$/);
    await vi.waitFor(() => {
      expect(execFileSync('docker', [
        'exec', config.dockerContainer, 'sh', '-c',
        'if [ -e /proc/"$1" ]; then echo present; else echo reaped; fi', 'sh', orphanPid
      ], { encoding: 'utf8', timeout: 5_000 }).trim()).toBe('reaped');
    }, { timeout: 10_000, interval: 250 });
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
