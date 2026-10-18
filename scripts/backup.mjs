#!/usr/bin/env node
import { backup, DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { chmod, cp, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

process.umask(0o077);

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(root, '.env');
if (existsSync(envPath)) process.loadEnvFile(envPath);

const configuredData = process.env.OVERROOT_DATA_DIR ?? './data';
const dataDir = isAbsolute(configuredData) ? configuredData : resolve(root, configuredData);
const destinationRoot = process.env.OVERROOT_BACKUP_DIR ?? resolve(root, 'backups');
const databasePath = join(dataDir, 'overroot.sqlite3');
const timestamp = `${new Date().toISOString().replaceAll(':', '-')}-${process.pid}`;
const staging = join(destinationRoot, `.${timestamp}.tmp`);
const destination = join(destinationRoot, timestamp);

await mkdir(destinationRoot, { recursive: true, mode: 0o700 });
await chmod(destinationRoot, 0o700);
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true, mode: 0o700 });

let source;
try {
  source = new DatabaseSync(databasePath, { readOnly: true });
  await backup(source, join(staging, 'overroot.sqlite3'));
} catch (error) {
  await rm(staging, { recursive: true, force: true });
  throw error;
} finally {
  source?.close();
}

await chmod(join(staging, 'overroot.sqlite3'), 0o600);
const copied = new DatabaseSync(join(staging, 'overroot.sqlite3'), { readOnly: true });
const integrity = copied.prepare('PRAGMA integrity_check').get()?.integrity_check;
copied.close();
await rm(join(staging, 'overroot.sqlite3-wal'), { force: true });
await rm(join(staging, 'overroot.sqlite3-shm'), { force: true });
if (integrity !== 'ok') {
  await rm(staging, { recursive: true, force: true });
  throw new Error(`Backup integrity check failed: ${String(integrity)}`);
}

const compileCache = join(dataDir, 'compile-cache');
if (await exists(compileCache)) await cp(compileCache, join(staging, 'compile-cache'), { recursive: true });
await writeFile(
  join(staging, 'manifest.json'),
  `${JSON.stringify({ createdAt: new Date().toISOString(), source: databasePath, integrity, secretsIncluded: false }, null, 2)}\n`,
  { mode: 0o600 }
);
await rename(staging, destination);

const snapshots = (await readdir(destinationRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}T/.test(entry.name))
  .map((entry) => entry.name)
  .sort()
  .reverse();
for (const old of snapshots.slice(3)) await rm(join(destinationRoot, old), { recursive: true, force: true });

console.log(`Overroot backup complete: ${destination}`);

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
