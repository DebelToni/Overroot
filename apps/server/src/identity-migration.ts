import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { Database } from './database.js';

// Operator supplied, never inferred from email, nickname, or local handle.
export const mappingSchema = z.object({ version: z.literal(1), mappings: z.array(z.object({ overroot_user_id: z.string().min(1), space_user_id: z.string().min(1).max(256) }).strict()) }).strict();

export function migrateIdentities(db: Database, input: unknown, recovery: DatabaseSync): void {
  const { mappings } = mappingSchema.parse(input);
  if (db.get<{ completed: number }>('SELECT completed FROM identity_migration WHERE id = 1')?.completed) throw new Error('Identity migration is already complete');
  if (recovery.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok') throw new Error('Recovery database integrity check failed');
  db.transaction(() => {
    // Compare actual content, including original file/PDF blobs and permissions, not just counts.
    for (const table of ['users', 'projects', 'project_members', 'files', 'file_revisions', 'agent_credentials', 'audit_events', 'compile_jobs']) {
      const current = db.all(`SELECT * FROM ${table} ORDER BY rowid`);
      const saved = recovery.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
      if (JSON.stringify(current) !== JSON.stringify(saved)) throw new Error(`Recovery differs from current ${table}; take and verify a fresh backup with the service stopped`);
    }
    const users = db.all<{ id: string }>('SELECT id FROM users');
    const local = new Set(mappings.map((row) => row.overroot_user_id));
    const central = new Set(mappings.map((row) => row.space_user_id));
    if (mappings.length !== users.length || local.size !== users.length || central.size !== users.length || users.some((user) => !local.has(user.id))) throw new Error('Mapping must cover every existing local user exactly once, with unique Space IDs');
    if (db.get('SELECT subject FROM external_identities LIMIT 1')) throw new Error('Unexpected existing identity links');
    for (const row of mappings) db.run('INSERT INTO external_identities (subject, user_id) VALUES (?, ?)', row.space_user_id, row.overroot_user_id);
    db.run("UPDATE users SET password_hash = ''");
    db.run('DELETE FROM sessions');
    db.run('DELETE FROM invites');
    db.run('UPDATE identity_migration SET completed = 1 WHERE id = 1');
  });
}
