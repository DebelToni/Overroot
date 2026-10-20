import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

process.umask(0o077);

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, '../../..');

try {
  const envPath = resolve(repoRoot, '.env');
  if (existsSync(envPath)) process.loadEnvFile(envPath);
} catch {
  // Environment variables still work when .env loading is unavailable.
}

function integer(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) ? value : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value == null) return fallback;
  return value === '1' || value.toLowerCase() === 'true';
}

const configuredDataDir = process.env.OVERROOT_DATA_DIR ?? './data';
export const config = {
  host: process.env.OVERROOT_HOST ?? '127.0.0.1',
  port: integer('OVERROOT_PORT', 4317),
  dataDir: isAbsolute(configuredDataDir) ? configuredDataDir : resolve(repoRoot, configuredDataDir),
  allowedOrigins: (process.env.OVERROOT_ALLOWED_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173,https://overroot.toni.foo')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  publicUrl: (process.env.OVERROOT_PUBLIC_URL ?? 'https://overroot.toni.foo').replace(/\/+$/, ''),
  compileTimeoutSeconds: integer('OVERROOT_COMPILE_TIMEOUT_SECONDS', 45),
  compileMaxJobs: integer('OVERROOT_COMPILE_MAX_JOBS', 8),
  compileMaxSnapshotBytes: integer('OVERROOT_COMPILE_MAX_SNAPSHOT_BYTES', 128 * 1024 * 1024),
  dockerImage: process.env.OVERROOT_DOCKER_IMAGE ?? 'overroot-tectonic:0.16.9',
  dockerContainer: process.env.OVERROOT_DOCKER_CONTAINER ?? 'overroot-tectonic-worker',
  fakeCompiler: bool('OVERROOT_FAKE_COMPILER', false),
  trustProxy: bool('OVERROOT_TRUST_PROXY', true),
  webDist: resolve(repoRoot, 'apps/web/dist'),
  dockerfileDir: resolve(repoRoot, 'docker/tectonic')
};

mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
chmodSync(config.dataDir, 0o700);
