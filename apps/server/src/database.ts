import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { config } from './config.js';

export class Database {
  readonly raw: DatabaseSync;

  constructor(path = `${config.dataDir}/overroot.sqlite3`) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.raw = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.raw.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA temp_store = MEMORY;
    `);
    this.migrate();
    this.raw.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS compile_inflight_unique ON compile_jobs(project_id, source_hash) WHERE status IN ('queued', 'compiling')"
    );
  }

  private migrate(): void {
    const version = Number(this.raw.prepare('PRAGMA user_version').get()?.user_version ?? 0);
    if (version > 2) throw new Error(`Database schema ${version} is newer than this Overroot build`);
    if (version === 0) {
      this.raw.exec(`
        BEGIN IMMEDIATE;

        CREATE TABLE users (
          id TEXT PRIMARY KEY,
          username TEXT NOT NULL COLLATE NOCASE UNIQUE,
          display_name TEXT NOT NULL,
          password_hash TEXT NOT NULL,
          is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
          created_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE invites (
          id TEXT PRIMARY KEY,
          token_hash TEXT NOT NULL UNIQUE,
          created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          expires_at TEXT NOT NULL,
          used_at TEXT,
          used_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          created_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE sessions (
          token_hash TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          expires_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          created_at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX sessions_user_idx ON sessions(user_id);

        CREATE TABLE projects (
          id TEXT PRIMARY KEY,
          public_hash TEXT NOT NULL UNIQUE,
          owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
          name TEXT NOT NULL,
          entry_file TEXT NOT NULL DEFAULT 'main.tex',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE project_members (
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
          created_at TEXT NOT NULL,
          PRIMARY KEY (project_id, user_id)
        ) STRICT;
        CREATE INDEX project_members_user_idx ON project_members(user_id);

        CREATE TABLE files (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          path TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('text', 'binary')),
          mime_type TEXT NOT NULL,
          content BLOB NOT NULL,
          y_state BLOB,
          revision_hash TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (project_id, path)
        ) STRICT;
        CREATE INDEX files_project_idx ON files(project_id, path);

        CREATE TABLE file_revisions (
          id TEXT PRIMARY KEY,
          file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
          revision_hash TEXT NOT NULL,
          content BLOB NOT NULL,
          actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'agent', 'system')),
          actor_id TEXT NOT NULL,
          actor_name TEXT NOT NULL,
          created_at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX revisions_file_idx ON file_revisions(file_id, created_at DESC);

        CREATE TABLE agent_credentials (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          token_hash TEXT NOT NULL UNIQUE,
          created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          last_used_at TEXT,
          revoked_at TEXT,
          created_at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX agent_project_idx ON agent_credentials(project_id);

        CREATE TABLE compile_jobs (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          source_hash TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('queued', 'compiling', 'succeeded', 'failed', 'cancelled')),
          entry_file TEXT NOT NULL,
          pdf_path TEXT,
          synctex_path TEXT,
          log TEXT NOT NULL DEFAULT '',
          error TEXT,
          requested_by_type TEXT NOT NULL CHECK (requested_by_type IN ('user', 'agent', 'system')),
          requested_by_id TEXT NOT NULL,
          requested_by_name TEXT NOT NULL,
          created_at TEXT NOT NULL,
          started_at TEXT,
          finished_at TEXT
        ) STRICT;
        CREATE INDEX compile_project_idx ON compile_jobs(project_id, created_at DESC);
        CREATE INDEX compile_source_idx ON compile_jobs(project_id, source_hash, status);

        CREATE TABLE audit_events (
          id TEXT PRIMARY KEY,
          project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
          actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'agent', 'system')),
          actor_id TEXT NOT NULL,
          actor_name TEXT NOT NULL,
          action TEXT NOT NULL,
          metadata_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX audit_project_idx ON audit_events(project_id, created_at DESC);

        PRAGMA user_version = 2;
        COMMIT;
      `);
    } else if (version === 1) {
      this.raw.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE files ADD COLUMN y_state BLOB;
        PRAGMA user_version = 2;
        COMMIT;
      `);
    }
  }

  get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.raw.prepare(sql).get(...params) as T | undefined;
  }

  all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.raw.prepare(sql).all(...params) as T[];
  }

  run(sql: string, ...params: SQLInputValue[]): { changes: number | bigint; lastInsertRowid: number | bigint } {
    return this.raw.prepare(sql).run(...params);
  }

  transaction<T>(callback: () => T): T {
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const result = callback();
      this.raw.exec('COMMIT');
      return result;
    } catch (error) {
      this.raw.exec('ROLLBACK');
      throw error;
    }
  }

  checkpoint(): void {
    this.raw.exec('PRAGMA wal_checkpoint(PASSIVE)');
  }

  close(): void {
    this.raw.close();
  }
}
