import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvedRun, deploymentDecision, deploy } from './deploy.mjs';

const sha = 'a'.repeat(40);
const success = { head_sha: sha, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success' };

test('only successful completed main push for exact SHA approves', () => {
  assert.equal(approvedRun([success], sha), true);
  for (const change of [{ head_sha: 'b'.repeat(40) }, { head_branch: 'feature' },
    { event: 'pull_request' }, { status: 'in_progress' }, { conclusion: 'failure' }]) {
    assert.equal(approvedRun([{ ...success, ...change }], sha), false);
  }
  assert.equal(deploymentDecision(sha, { sha }, []), 'unchanged');
  assert.equal(deploymentDecision(sha, null, []), 'awaiting-ci');
  assert.equal(deploymentDecision(sha, null, [success]), 'deploy');
});

async function fixture(t, { runs = [success], fail, healthy = true } = {}) {
  const state = await mkdtemp(join(tmpdir(), 'overroot-deploy-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const old = join(state, 'old');
  await mkdir(old);
  await symlink(old, join(state, 'current'));
  const calls = [];
  const receipt = () => readFile(join(state, 'deployed.json'), 'utf8');
  const current = () => readlink(join(state, 'current'));
  const run = async (command, args, options) => {
    const step = command === 'git' ? (args.includes('archive') ? 'archive' : 'git')
      : command === 'tar' ? 'extract'
      : command === 'pnpm' ? (args.includes('install') ? 'install' : 'build')
      : command === 'systemctl' ? args[1]
      : command === 'gh' ? 'ci' : 'backup';
    calls.push(step);
    if (step === fail) { fail = undefined; throw new Error(`failed ${step}`); }
    if (args.includes('rev-parse')) return sha;
    if (step === 'ci') return JSON.stringify({ workflow_runs: runs });
    if (step === 'archive') await writeFile(args.find(a => a.startsWith('--output=')).slice(9), 'fake archive');
    if (['install', 'build'].includes(step)) {
      assert.equal(options.env.NODE_ENV, 'development');
      assert.ok(options.cwd.startsWith(join(state, 'releases', '.')));
    }
    if (step === 'backup' || step === 'stop') assert.equal(await current(), old);
    if (step === 'backup') assert.ok(args[0].startsWith(join(state, 'releases')));
    if (step === 'start') {
      assert.notEqual(await current(), old);
      await assert.rejects(receipt(), { code: 'ENOENT' });
    }
    return '';
  };
  const health = async () => {
    calls.push('health');
    assert.notEqual(await current(), old);
    await assert.rejects(receipt(), { code: 'ENOENT' });
    return healthy;
  };
  return { state, calls, old, current, receipt,
    deploy: () => deploy({ state, run, health, wait: async () => {} }) };
}

test('unchanged main does not query CI or touch the running release', async t => {
  const f = await fixture(t);
  await writeFile(join(f.state, 'deployed.json'), JSON.stringify({ sha }));
  assert.equal(await f.deploy(), 'unchanged');
  assert.ok(f.calls.every(step => step === 'git'));
  assert.equal(await f.current(), f.old);
});

for (const change of [{ status: 'in_progress', conclusion: null }, { conclusion: 'failure' }, { event: 'pull_request' }]) {
  test(`unapproved CI ${JSON.stringify(change)} creates no release or backup and never stops`, async t => {
    const f = await fixture(t, { runs: [{ ...success, ...change }] });
    assert.equal(await f.deploy(), 'awaiting-ci');
    assert.deepEqual(f.calls.filter(step => step !== 'git'), ['ci']);
    await assert.rejects(access(join(f.state, 'releases')), { code: 'ENOENT' });
    await assert.rejects(f.receipt(), { code: 'ENOENT' });
    assert.equal(await f.current(), f.old);
  });
}

test('approved deployment builds, backs up, stops, switches, starts, checks health then records receipt', async t => {
  const f = await fixture(t);
  assert.equal(await f.deploy(), `deployed ${sha}`);
  assert.deepEqual(f.calls.filter(step => step !== 'git'),
    ['ci', 'archive', 'extract', 'install', 'build', 'backup', 'stop', 'start', 'health']);
  assert.equal(JSON.parse(await f.receipt()).sha, sha);
  await access(await f.current());
  await assert.rejects(access(join(f.state, 'deploy.lock')), { code: 'ENOENT' });
});

for (const fail of ['build', 'backup']) {
  test(`${fail} failure never stops and can retry the same SHA`, async t => {
    const f = await fixture(t, { fail });
    await assert.rejects(f.deploy(), new RegExp(`failed ${fail}`));
    assert.equal(f.calls.includes('stop'), false);
    assert.equal(await f.current(), f.old);
    await assert.rejects(f.receipt(), { code: 'ENOENT' });
    await assert.rejects(access(join(f.state, 'deploy.lock')), { code: 'ENOENT' });
    assert.equal(await f.deploy(), `deployed ${sha}`);
  });
}

test('failed health never records a successful deployment', async t => {
  const f = await fixture(t, { healthy: false });
  await assert.rejects(f.deploy(), /Health check failed/);
  assert.equal(f.calls.filter(step => step === 'health').length, 30);
  await assert.rejects(f.receipt(), { code: 'ENOENT' });
});
