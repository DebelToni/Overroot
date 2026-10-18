#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rename, rm, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFile } from 'node:fs/promises';

const exec = promisify(execFile);
const repository = 'DebelToni/Overroot';
const remote = `git@github.com:${repository}.git`;

export function approvedRun(runs, sha) {
  return runs.some(run => run.head_sha === sha && run.head_branch === 'main'
    && run.event === 'push' && run.status === 'completed' && run.conclusion === 'success');
}

export function deploymentDecision(sha, receipt, runs) {
  if (receipt?.sha === sha) return 'unchanged';
  return approvedRun(runs, sha) ? 'deploy' : 'awaiting-ci';
}

async function optionalJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function deploy({ state = join(homedir(), '.local/state/overroot'),
  run = async (command, args, options = {}) => (await exec(command, args,
    { ...options, maxBuffer: 16 * 1024 * 1024 })).stdout,
  health = async () => (await fetch('http://127.0.0.1:4317/health',
    { signal: AbortSignal.timeout(3000) })).ok,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  process.umask(0o077);
  await mkdir(state, { recursive: true });
  const lock = join(state, 'deploy.lock');
  await mkdir(lock); // Concurrent or interrupted updater requires explicit operator attention.
  let staging;
  const next = join(state, `current-${process.pid}.tmp`);
  try {
    const repo = join(state, 'deploy-repo.git');
    await mkdir(repo, { recursive: true });
    await run('git', ['init', '--bare', repo]);
    await run('git', ['--git-dir', repo, 'config', 'remote.origin.url', remote]);
    // Explicit refspec makes the fetched main SHA independent of any checkout.
    await run('git', ['--git-dir', repo, 'fetch', 'origin', '+refs/heads/main:refs/heads/main']);
    const sha = (await run('git', ['--git-dir', repo, 'rev-parse', 'refs/heads/main'])).trim();
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`Invalid main SHA: ${sha}`);
    const receiptPath = join(state, 'deployed.json');
    const receipt = await optionalJson(receiptPath);
    if (receipt?.sha === sha) return 'unchanged';
    const response = JSON.parse(await run('gh', ['api', '--method', 'GET',
      `repos/${repository}/actions/workflows/ci.yml/runs`,
      '-f', 'event=push', '-f', 'branch=main', '-f', `head_sha=${sha}`, '-f', 'per_page=100']));
    if (deploymentDecision(sha, receipt, response.workflow_runs) !== 'deploy') return 'awaiting-ci';

    const releases = join(state, 'releases');
    await mkdir(releases, { recursive: true });
    staging = await mkdtemp(join(releases, `.${sha}-`));
    const release = join(releases, basename(staging).slice(1));
    const archive = join(staging, 'source.tar');
    await run('git', ['--git-dir', repo, 'archive', '--format=tar', `--output=${archive}`, sha]);
    await run('tar', ['-xf', archive, '-C', staging]);
    await rm(archive);
    // Build tools must remain available even though runtime.env sets NODE_ENV=production.
    const env = { ...process.env, NODE_ENV: 'development' };
    await run('pnpm', ['install', '--frozen-lockfile'], { cwd: staging, env });
    await run('pnpm', ['build'], { cwd: staging, env });
    await rename(staging, release);

    await run(process.execPath, [join(release, 'scripts/backup.mjs')], { cwd: release,
      env: { ...process.env,
        OVERROOT_DATA_DIR: process.env.OVERROOT_DATA_DIR ?? join(state, 'data'),
        OVERROOT_BACKUP_DIR: process.env.OVERROOT_BACKUP_DIR ?? join(state, 'backups') } });
    await symlink(release, next);
    await run('systemctl', ['--user', 'stop', 'overroot.service']);
    await rename(next, join(state, 'current'));
    await run('systemctl', ['--user', 'start', 'overroot.service']);
    let healthy = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      try { healthy = await health(); } catch { healthy = false; }
      if (healthy) break;
      await wait(1000);
    }
    if (!healthy) throw new Error(`Health check failed for ${sha}; operator intervention required`);
    const receiptTmp = `${receiptPath}.tmp`;
    await writeFile(receiptTmp, `${JSON.stringify({ sha, deployedAt: new Date().toISOString() })}\n`);
    await rename(receiptTmp, receiptPath);
    return `deployed ${sha}`;
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
    await rm(next, { force: true });
    await rm(lock, { recursive: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(await deploy());
}
