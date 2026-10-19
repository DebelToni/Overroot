import { randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { config, repoRoot } from './config.js';
import type { CollaborationManager, EventHub } from './collaboration.js';
import type { Database } from './database.js';
import { HttpError } from './errors.js';
import type { ProjectStore } from './project-store.js';
import type { ActorIdentity, ProjectRecord } from './types.js';

interface CompileSource {
  path: string;
  content: Buffer;
}

export interface CompileJob {
  id: string;
  project_id: string;
  source_hash: string;
  status: 'queued' | 'compiling' | 'succeeded' | 'failed' | 'cancelled';
  entry_file: string;
  pdf_path: string | null;
  synctex_path: string | null;
  log: string;
  error: string | null;
  requested_by_type: string;
  requested_by_id: string;
  requested_by_name: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export class Compiler {
  private queue: Promise<void> = Promise.resolve();
  private workerReady: Promise<void> | null = null;
  private closing = false;
  private readonly jobsDir: string;
  private readonly cacheDir: string;

  constructor(
    private readonly db: Database,
    private readonly store: ProjectStore,
    private readonly collaboration: CollaborationManager,
    private readonly events: EventHub,
    dataDir = config.dataDir
  ) {
    this.jobsDir = join(dataDir, 'jobs');
    this.cacheDir = join(dataDir, 'compile-cache');
  }

  async initialize(): Promise<void> {
    await mkdir(this.jobsDir, { recursive: true, mode: 0o700 });
    // The isolated compiler UID needs traversal; the private data directory still protects host access.
    await chmod(this.jobsDir, 0o711);
    await mkdir(this.cacheDir, { recursive: true, mode: 0o700 });
    const now = new Date().toISOString();
    this.db.run(
      "UPDATE compile_jobs SET status = 'cancelled', error = 'Server restarted during compilation', finished_at = ? WHERE status IN ('queued', 'compiling')",
      now
    );
  }

  async request(project: ProjectRecord, actor: ActorIdentity): Promise<CompileJob> {
    if (this.closing) throw new HttpError(503, 'The compiler is shutting down', 'compiler_unavailable');
    await this.collaboration.flushProject(project.id);
    project = { ...project };
    const entry = this.store.getFile(project.id, project.entry_file);
    if (!entry || entry.kind !== 'text') throw new HttpError(400, 'The project entry file does not exist', 'entry_file_missing');
    const sourceHash = this.store.sourceHash(project.id, [
      project.entry_file,
      config.fakeCompiler ? 'fake-compiler-v1' : config.dockerImage,
      'tectonic-v3:untrusted:synctex:snapshot'
    ]);
    // Hash and copy in the same synchronous turn, before cache I/O or queue waits.
    // Later edits, renames and deletions must not change this job's inputs.
    const sources = this.store.listFiles(project.id).map(file => ({ path: file.path, content: Buffer.from(file.content) }));
    const inFlight = this.db.get<CompileJob>(
      `SELECT * FROM compile_jobs
       WHERE project_id = ? AND source_hash = ? AND status IN ('queued', 'compiling')
       ORDER BY created_at DESC LIMIT 1`,
      project.id,
      sourceHash
    );
    if (inFlight) return inFlight;

    const cachedPdf = join(this.cacheDir, `${sourceHash}.pdf`);
    const cachedLog = join(this.cacheDir, `${sourceHash}.log`);
    if (await fileExists(cachedPdf)) {
      const cachedSynctex = join(this.cacheDir, `${sourceHash}.synctex.gz`);
      const synctexPath = await fileExists(cachedSynctex) ? cachedSynctex : null;
      const now = new Date().toISOString();
      const job = this.insertJob(project, sourceHash, actor, 'succeeded', now, now, cachedPdf, await readOptional(cachedLog), null, synctexPath);
      this.events.emit(project.id, { type: 'compile.ready', job: publicCompileJob(job), cached: true });
      return job;
    }

    let job: CompileJob;
    try {
      job = this.insertJob(project, sourceHash, actor, 'queued');
    } catch (error) {
      const concurrent = this.db.get<CompileJob>(
        `SELECT * FROM compile_jobs
         WHERE project_id = ? AND source_hash = ? AND status IN ('queued', 'compiling')
         ORDER BY created_at DESC LIMIT 1`,
        project.id,
        sourceHash
      );
      if (concurrent) return concurrent;
      throw error;
    }
    this.events.emit(project.id, { type: 'compile.queued', job: publicCompileJob(job) });
    this.queue = this.queue.then(() => this.run(job, project, sources)).catch((error) => {
      console.error('[compile queue]', error);
    });
    return job;
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.queue;
    this.db.run(
      "UPDATE compile_jobs SET status = 'cancelled', error = 'Server stopped before compilation', finished_at = ? WHERE status IN ('queued', 'compiling')",
      new Date().toISOString()
    );
  }

  get(jobId: string, projectId: string): CompileJob | undefined {
    return this.db.get<CompileJob>('SELECT * FROM compile_jobs WHERE id = ? AND project_id = ?', jobId, projectId);
  }

  latest(projectId: string): CompileJob | undefined {
    return this.db.get<CompileJob>(
      `SELECT * FROM compile_jobs
       WHERE project_id = ?
       ORDER BY created_at DESC LIMIT 1`,
      projectId
    );
  }

  latestSuccessful(projectId: string): CompileJob | undefined {
    return this.db.get<CompileJob>(
      `SELECT * FROM compile_jobs
       WHERE project_id = ? AND status = 'succeeded' AND pdf_path IS NOT NULL
       ORDER BY created_at DESC LIMIT 1`,
      projectId
    );
  }

  artifactPath(job: CompileJob, type: 'pdf' | 'synctex'): string {
    const path = type === 'pdf' ? job.pdf_path : job.synctex_path;
    if (!path) throw new HttpError(404, `${type.toUpperCase()} artifact not found`, 'artifact_not_found');
    const resolved = resolve(path);
    if (!isChildPath(this.cacheDir, resolved)) throw new HttpError(404, 'Artifact not found', 'artifact_not_found');
    return resolved;
  }

  private insertJob(
    project: ProjectRecord,
    sourceHash: string,
    actor: ActorIdentity,
    status: CompileJob['status'],
    startedAt: string | null = null,
    finishedAt: string | null = null,
    pdfPath: string | null = null,
    log = '',
    error: string | null = null,
    synctexPath: string | null = null
  ): CompileJob {
    const job: CompileJob = {
      id: randomUUID(),
      project_id: project.id,
      source_hash: sourceHash,
      status,
      entry_file: project.entry_file,
      pdf_path: pdfPath,
      synctex_path: synctexPath,
      log,
      error,
      requested_by_type: actor.type,
      requested_by_id: actor.id,
      requested_by_name: actor.name,
      created_at: new Date().toISOString(),
      started_at: startedAt,
      finished_at: finishedAt
    };
    this.db.run(
      `INSERT INTO compile_jobs
        (id, project_id, source_hash, status, entry_file, pdf_path, synctex_path, log, error,
         requested_by_type, requested_by_id, requested_by_name, created_at, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      job.id,
      job.project_id,
      job.source_hash,
      job.status,
      job.entry_file,
      job.pdf_path,
      job.synctex_path,
      job.log,
      job.error,
      job.requested_by_type,
      job.requested_by_id,
      job.requested_by_name,
      job.created_at,
      job.started_at,
      job.finished_at
    );
    return job;
  }

  private async run(job: CompileJob, project: ProjectRecord, sources: CompileSource[]): Promise<void> {
    const startedAt = new Date().toISOString();
    this.db.run("UPDATE compile_jobs SET status = 'compiling', started_at = ? WHERE id = ?", startedAt, job.id);
    this.events.emit(project.id, { type: 'compile.started', job: { ...publicCompileJob(job), status: 'compiling', startedAt } });

    const workDir = join(this.jobsDir, job.id);
    const outputDir = join(workDir, '.overroot-output');
    try {
      await mkdir(outputDir, { recursive: true });
      for (const file of sources) {
        const destination = join(workDir, file.path);
        if (!isChildPath(workDir, destination)) throw new Error('Unsafe project path');
        let directory = workDir;
        for (const part of file.path.split('/').slice(0, -1)) {
          directory = join(directory, part);
          await mkdir(directory, { recursive: true });
          await chmod(directory, 0o755);
        }
        await writeFile(destination, file.content);
        await chmod(destination, 0o644);
      }
      await chmod(workDir, 0o755);
      await chmod(outputDir, 0o777);

      let output: CommandResult;
      if (config.fakeCompiler) {
        const pdfName = `${basename(project.entry_file, extname(project.entry_file))}.pdf`;
        await writeFile(join(outputDir, pdfName), createMinimalPdf(project.name));
        output = { code: 0, stdout: 'Fake compiler completed', stderr: '' };
      } else {
        await this.ensureWorker();
        const containerJobDir = `/work/${relative(this.jobsDir, workDir).replaceAll('\\', '/')}`;
        output = await command(
          'docker',
          [
            'exec',
            '--workdir',
            containerJobDir,
            config.dockerContainer,
            'timeout',
            '-s',
            'KILL',
            String(config.compileTimeoutSeconds),
            'tectonic',
            '-X',
            'compile',
            '--untrusted',
            '--synctex',
            '--keep-logs',
            '--outdir',
            '.overroot-output',
            '--',
            project.entry_file
          ],
          (config.compileTimeoutSeconds + 10) * 1000
        );
      }

      const log = trimLog([output.stdout, output.stderr].filter(Boolean).join('\n'));
      const outputBase = basename(project.entry_file, extname(project.entry_file));
      const generatedPdf = join(outputDir, `${outputBase}.pdf`);
      if (output.code !== 0 || !(await fileExists(generatedPdf))) {
        throw new CompileFailure(log || `Tectonic exited with status ${output.code}`);
      }

      const pdfPath = join(this.cacheDir, `${job.source_hash}.pdf`);
      const logPath = join(this.cacheDir, `${job.source_hash}.log`);
      const generatedSynctex = join(outputDir, `${outputBase}.synctex.gz`);
      const synctexPath = (await fileExists(generatedSynctex)) ? join(this.cacheDir, `${job.source_hash}.synctex.gz`) : null;
      const pdfTemp = `${pdfPath}.${job.id}.tmp`;
      const logTemp = `${logPath}.${job.id}.tmp`;
      await copyFile(generatedPdf, pdfTemp);
      const signature = (await readFile(pdfTemp)).subarray(0, 5).toString();
      if (signature !== '%PDF-') throw new Error('Compiler produced an invalid PDF');
      await writeFile(logTemp, log, { mode: 0o600 });
      await rename(pdfTemp, pdfPath);
      await rename(logTemp, logPath);
      if (synctexPath) {
        const synctexTemp = `${synctexPath}.${job.id}.tmp`;
        await copyFile(generatedSynctex, synctexTemp);
        await rename(synctexTemp, synctexPath);
      }
      const finishedAt = new Date().toISOString();
      this.db.run(
        `UPDATE compile_jobs
         SET status = 'succeeded', pdf_path = ?, synctex_path = ?, log = ?, finished_at = ?
         WHERE id = ?`,
        pdfPath,
        synctexPath,
        log,
        finishedAt,
        job.id
      );
      const complete = this.get(job.id, project.id)!;
      this.events.emit(project.id, { type: 'compile.ready', job: publicCompileJob(complete), cached: false });
    } catch (error) {
      const message = error instanceof CompileFailure ? error.message : error instanceof Error ? error.message : 'Compilation failed';
      const finishedAt = new Date().toISOString();
      this.db.run(
        "UPDATE compile_jobs SET status = 'failed', log = ?, error = ?, finished_at = ? WHERE id = ?",
        trimLog(message),
        message.slice(0, 2000),
        finishedAt,
        job.id
      );
      const failed = this.get(job.id, project.id)!;
      this.events.emit(project.id, { type: 'compile.failed', job: publicCompileJob(failed) });
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  private ensureWorker(): Promise<void> {
    if (this.workerReady) return this.workerReady;
    this.workerReady = this.prepareWorker().catch((error) => {
      this.workerReady = null;
      throw error;
    });
    return this.workerReady;
  }

  private async prepareWorker(): Promise<void> {
    const jobsMountDir = await realpath(this.jobsDir);
    const docker = await command('docker', ['info'], 15_000);
    if (docker.code !== 0) throw new Error('Docker is not running. Open Docker Desktop and compile again.');

    let image = await command('docker', ['image', 'inspect', config.dockerImage], 15_000);
    if (image.code !== 0) {
      const built = await command('docker', ['build', '-t', config.dockerImage, config.dockerfileDir], 10 * 60_000, true);
      if (built.code !== 0) throw new Error(`Could not build the Tectonic image:\n${trimLog(built.stderr || built.stdout)}`);
      image = await command('docker', ['image', 'inspect', config.dockerImage], 15_000);
    }

    const inspect = await command('docker', ['inspect', config.dockerContainer], 15_000);
    if (inspect.code === 0 && workerMatches(inspect.stdout, image.stdout, jobsMountDir)) return;
    if (inspect.code === 0) await command('docker', ['rm', '-f', config.dockerContainer], 20_000);
    await command('docker', ['volume', 'create', 'overroot-tectonic-cache'], 20_000);
    const started = await command(
      'docker',
      [
        'run',
        '-d',
        '--name',
        config.dockerContainer,
        '--restart',
        'unless-stopped',
        '--cpus=2',
        '--memory=1g',
        '--pids-limit=128',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        '--read-only',
        '--tmpfs',
        '/tmp:rw,nosuid,nodev,size=256m',
        '-v',
        'overroot-tectonic-cache:/var/cache/tectonic',
        '-v',
        `${jobsMountDir}:/work:rw`,
        config.dockerImage
      ],
      60_000
    );
    if (started.code !== 0) throw new Error(`Could not start the Tectonic worker:\n${trimLog(started.stderr)}`);
  }
}

export function publicCompileJob(job: CompileJob): Record<string, unknown> {
  return {
    id: job.id,
    sourceHash: job.source_hash,
    status: job.status,
    entryFile: job.entry_file,
    log: job.log,
    error: job.error,
    requestedBy: { type: job.requested_by_type, id: job.requested_by_id, name: job.requested_by_name },
    createdAt: job.created_at,
    startedAt: job.started_at,
    finishedAt: job.finished_at,
    hasPdf: Boolean(job.pdf_path),
    hasSynctex: Boolean(job.synctex_path)
  };
}

function isChildPath(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child));
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function workerMatches(containerJson: string, imageJson: string, jobsDir: string): boolean {
  try {
    const container = JSON.parse(containerJson)[0];
    const image = JSON.parse(imageJson)[0];
    const mounts = container.Mounts as Array<{ Source: string; Destination: string; RW: boolean }>;
    const work = mounts.find((mount) => mount.Destination === '/work');
    const cache = mounts.find((mount) => mount.Destination === '/var/cache/tectonic');
    return (
      container.State?.Running === true &&
      container.Image === image.Id &&
      container.Config?.Image === config.dockerImage &&
      container.Config?.User === 'tectonic' &&
      container.HostConfig?.ReadonlyRootfs === true &&
      container.HostConfig?.Memory === 1024 * 1024 * 1024 &&
      container.HostConfig?.PidsLimit === 128 &&
      container.HostConfig?.CapDrop?.includes('ALL') &&
      work?.RW === true && resolve(work.Source) === resolve(jobsDir) &&
      cache?.RW === true
    );
  } catch {
    return false;
  }
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

function command(program: string, args: string[], timeoutMs: number, inherit = false): Promise<CommandResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(program, args, {
      cwd: repoRoot,
      stdio: inherit ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
      if (inherit) process.stdout.write(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
      if (inherit) process.stderr.write(chunk);
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolvePromise({ code: 127, stdout, stderr: `${stderr}\n${error.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function readOptional(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}

function trimLog(log: string): string {
  return log.replaceAll(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '').slice(-200_000).trim();
}

class CompileFailure extends Error {}

function createMinimalPdf(title: string): Buffer {
  const escaped = title.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${42 + escaped.length} >>\nstream\nBT /F1 18 Tf 72 720 Td (${escaped}) Tj ET\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}
