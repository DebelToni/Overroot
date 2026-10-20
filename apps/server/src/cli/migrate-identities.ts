import { readFileSync, realpathSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';
import { Database } from '../database.js';
import { migrateIdentities } from '../identity-migration.js';

const [mappingPath, recoveryPath] = process.argv.slice(2);
if (!mappingPath || !recoveryPath || process.argv.length !== 4) throw new Error('Usage: accounts:migrate /private/mapping.json /verified/backup.sqlite3 (service must be stopped)');
if ((statSync(mappingPath).mode & 0o077) !== 0) throw new Error('Mapping file must be owner-only');
const target = `${config.dataDir}/overroot.sqlite3`;
const targetStat = statSync(target);
const recoveryStat = statSync(recoveryPath);
if (realpathSync(target) === realpathSync(recoveryPath) || (targetStat.dev === recoveryStat.dev && targetStat.ino === recoveryStat.ino)) throw new Error('Recovery must be a separate verified backup');
const recovery = new DatabaseSync(recoveryPath, { readOnly: true });
const db = new Database(target);
try {
  migrateIdentities(db, JSON.parse(readFileSync(mappingPath, 'utf8')), recovery);
  db.checkpoint();
  console.log('Identity migration complete. Local IDs, permissions, content and agent credentials preserved; human verifiers, sessions and invitations retired.');
} finally { db.close(); recovery.close(); }
