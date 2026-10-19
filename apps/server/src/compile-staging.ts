import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface CompileSource {
  path: string;
  content: Uint8Array;
}

const WRITE_CONCURRENCY = 8;

export async function stageCompileSources(workDir: string, sources: readonly CompileSource[]): Promise<void> {
  const root = resolve(workDir);
  // Validate the entire plan before creating anything, including on native Windows paths.
  const files = sources.map(file => {
    const destination = resolve(root, file.path);
    const child = relative(root, destination);
    if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new Error('Unsafe project path');
    return { destination, content: file.content };
  });
  const outputDir = join(root, '.overroot-output');
  await mkdir(outputDir, { recursive: true });
  await chmod(root, 0o755);
  await chmod(outputDir, 0o777);

  const directories = new Map<string, Promise<void>>([[root, Promise.resolve()]]);
  function ensureDirectory(directory: string): Promise<void> {
    const existing = directories.get(directory);
    if (existing) return existing;
    const ready = ensureDirectory(dirname(directory)).then(async () => {
      await mkdir(directory, { recursive: true });
      // Explicit permissions are required despite the private process umask.
      await chmod(directory, 0o755);
    });
    directories.set(directory, ready);
    return ready;
  }

  for (let offset = 0; offset < files.length; offset += WRITE_CONCURRENCY) {
    const results = await Promise.allSettled(files.slice(offset, offset + WRITE_CONCURRENCY).map(async file => {
      await ensureDirectory(dirname(file.destination));
      await writeFile(file.destination, file.content);
      await chmod(file.destination, 0o644);
    }));
    // Drain this batch before throwing: cleanup must never race outstanding writes.
    const failure = results.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }
}
