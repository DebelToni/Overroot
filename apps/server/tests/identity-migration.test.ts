import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { Database } from '../src/database.js';
import { migrateIdentities } from '../src/identity-migration.js';
import { ProjectStore } from '../src/project-store.js';
import { seedUser } from './helpers.js';

let dir: string;
let db: Database;
let recovery: DatabaseSync;
let userId: string;
let projectId: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'overroot-mapping-'));
  db = new Database(join(dir, 'current.sqlite3'));
  const user = seedUser(db, 'original-owner', true);
  userId = user.id;
  const store = new ProjectStore(db);
  const project = store.createImportedProject(user.id, 'Original private project', [
    { path: 'main.tex', content: Buffer.from('Original private source') },
    { path: 'original.pdf', content: Buffer.from('%PDF-1.7\noriginal PDF bytes\n%%EOF') }
  ]);
  projectId = project.id;
  db.run('DELETE FROM external_identities');
  db.run('UPDATE identity_migration SET completed = 0');
  db.run("UPDATE users SET password_hash = 'legacy-verifier'");
  db.run("INSERT INTO sessions (token_hash, user_id, expires_at, last_seen_at, created_at) VALUES ('old-session', ?, '2099-01-01', 'now', 'now')", userId);
  db.run("INSERT INTO agent_credentials (id, project_id, name, token_hash, created_by, created_at) VALUES ('agent', ?, 'Original agent', 'agent-hash', ?, 'now')", projectId, userId);
  await backup(db.raw, join(dir, 'recovery.sqlite3'));
  recovery = new DatabaseSync(join(dir, 'recovery.sqlite3'), { readOnly: true });
});
afterEach(async () => { recovery.close(); db.close(); await rm(dir, { recursive: true, force: true }); });
const mapping = () => ({ version: 1, mappings: [{ overroot_user_id: userId, space_user_id: 'confirmed-space-id' }] });
it('preserves local IDs, admin grants, private memberships, original bytes, revisions and independent agent credentials', () => {
  const before = ['projects', 'project_members', 'files', 'file_revisions', 'agent_credentials'].map((table) => db.all(`SELECT * FROM ${table}`));
  migrateIdentities(db, mapping(), recovery);
  expect(db.get('SELECT id, username, is_admin, password_hash FROM users')).toEqual({ id: userId, username: 'original-owner', is_admin: 1, password_hash: '' });
  expect(db.get('SELECT * FROM external_identities')).toEqual({ subject: 'confirmed-space-id', user_id: userId });
  expect(db.all('SELECT * FROM sessions')).toEqual([]);
  expect(['projects', 'project_members', 'files', 'file_revisions', 'agent_credentials'].map((table) => db.all(`SELECT * FROM ${table}`))).toEqual(before);
  expect(() => migrateIdentities(db, mapping(), recovery)).toThrow('already complete');
});
it.each(['missing', 'unknown', 'duplicate-local', 'duplicate-central'] as const)('fails atomically on %s operator mappings', (kind) => {
  const input = mapping();
  if (kind === 'missing') input.mappings = [];
  if (kind === 'unknown') input.mappings[0]!.overroot_user_id = 'not-the-local-id';
  if (kind === 'duplicate-local') input.mappings.push({ overroot_user_id: userId, space_user_id: 'other' });
  if (kind === 'duplicate-central') input.mappings.push({ overroot_user_id: 'other', space_user_id: 'confirmed-space-id' });
  expect(() => migrateIdentities(db, input, recovery)).toThrow();
  expect(db.get<{ password_hash: string }>('SELECT password_hash FROM users')!.password_hash).toBe('legacy-verifier');
  expect(db.all('SELECT * FROM external_identities')).toEqual([]);
  expect(db.all('SELECT * FROM sessions')).toHaveLength(1);
});
it('refuses a stale recovery snapshot rather than destroy verifiers', () => {
  db.run("UPDATE files SET content = ? WHERE project_id = ?", Buffer.from('changed original bytes'), projectId);
  expect(() => migrateIdentities(db, mapping(), recovery)).toThrow('Recovery differs');
  expect(db.get<{ password_hash: string }>('SELECT password_hash FROM users')!.password_hash).toBe('legacy-verifier');
});
