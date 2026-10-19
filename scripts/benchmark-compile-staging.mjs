// Compare only filesystem staging, not Tectonic or end-to-end compilation.
// Baseline: compiler.ts staging loop at 03c741c.
// Node 24+: node scripts/benchmark-compile-staging.mjs [scratch-parent]
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { stageCompileSources } from '../apps/server/src/compile-staging.ts';

process.umask(0o077);
const scratch = await mkdtemp(join(process.argv[2] ?? tmpdir(), 'overroot-staging-benchmark-'));
async function baseline(workDir, sources) {
  const outputDir = join(workDir, '.overroot-output');
  await mkdir(outputDir, { recursive: true });
  for (const file of sources) {
    let directory = workDir;
    for (const part of file.path.split('/').slice(0, -1)) {
      directory = join(directory, part);
      await mkdir(directory, { recursive: true });
      await chmod(directory, 0o755);
    }
    await writeFile(join(workDir, file.path), file.content);
    await chmod(join(workDir, file.path), 0o644);
  }
  await chmod(workDir, 0o755);
  await chmod(outputDir, 0o777);
}

const median = values => {
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
};
try {
  for (const count of [1, 100, 500]) {
    const sources = Array.from({ length: count }, (_, i) => ({
      path: `sections/chapter-${Math.floor(i / 20)}/parts/file-${i}.tex`,
      content: Buffer.alloc(4096, 120)
    }));
    const timings = { baseline: [], optimized: [] };
    for (let round = 0; round < 9; round++) {
      // Alternate order; omit the first warmup pair. Cleanup is outside the timer.
      for (const name of round % 2 ? ['optimized', 'baseline'] : ['baseline', 'optimized']) {
        const workDir = join(scratch, `${count}-${round}-${name}`);
        const start = performance.now();
        await (name === 'baseline' ? baseline : stageCompileSources)(workDir, sources);
        const elapsed = performance.now() - start;
        if (round) timings[name].push(elapsed);
        await rm(workDir, { recursive: true, force: true });
      }
    }
    console.log(JSON.stringify({ files: count, bytesPerFile: 4096, samples: timings,
      baselineMedianMs: median(timings.baseline), optimizedMedianMs: median(timings.optimized),
      stagingSpeedup: median(timings.baseline) / median(timings.optimized) }));
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}
