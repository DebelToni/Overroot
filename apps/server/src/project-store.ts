import { createHash, randomUUID } from 'node:crypto';
import { lookup as mimeLookup } from 'mime-types';
import * as Y from 'yjs';
import type { Database } from './database.js';
import { HttpError } from './errors.js';
import { isTextMime, normalizeProjectPath } from './paths.js';
import { fileRevision, randomPublicId } from './security.js';
import { findTemplate } from './templates.js';
import type { ActorIdentity, FileRecord, ProjectRecord, ProjectRole } from './types.js';

export interface ProjectSummary extends ProjectRecord {
  role: ProjectRole;
  owner_name: string;
  member_count: number;
  latest_compile_status: string | null;
}

export class ProjectStore {
  constructor(private readonly db: Database) {}

  createProject(ownerId: string, nameInput: string, templateId = 'article'): ProjectRecord {
    const name = cleanProjectName(nameInput);
    const template = findTemplate(templateId);
    if (!template) throw new HttpError(400, 'Unknown project template', 'unknown_template');
    const now = new Date().toISOString();
    const project: ProjectRecord = {
      id: randomUUID(),
      public_hash: randomPublicId(),
      owner_id: ownerId,
      name,
      entry_file: template.entryFile,
      created_at: now,
      updated_at: now
    };
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO projects (id, public_hash, owner_id, name, entry_file, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        project.id,
        project.public_hash,
        project.owner_id,
        project.name,
        project.entry_file,
        project.created_at,
        project.updated_at
      );
      this.db.run(
        'INSERT INTO project_members (project_id, user_id, role, created_at) VALUES (?, ?, ?, ?)',
        project.id,
        ownerId,
        'owner',
        now
      );
      for (const [path, content] of Object.entries(template.files)) {
        this.insertFile(project.id, path, Buffer.from(content), 'text/plain', { type: 'system', id: 'template', name: template.name }, now);
      }
    });
    return project;
  }

  createImportedProject(
    ownerId: string,
    nameInput: string,
    files: Array<{ path: string; content: Uint8Array; mimeType?: string }>
  ): ProjectRecord {
    if (!files.length) throw new HttpError(400, 'The archive contains no files', 'empty_archive');
    const name = cleanProjectName(nameInput);
    const now = new Date().toISOString();
    const paths = files.map((file) => normalizeProjectPath(file.path));
    const entryFile = chooseEntryFile(paths);
    const project: ProjectRecord = {
      id: randomUUID(),
      public_hash: randomPublicId(),
      owner_id: ownerId,
      name,
      entry_file: entryFile,
      created_at: now,
      updated_at: now
    };
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO projects (id, public_hash, owner_id, name, entry_file, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        project.id,
        project.public_hash,
        project.owner_id,
        project.name,
        project.entry_file,
        project.created_at,
        project.updated_at
      );
      this.db.run(
        'INSERT INTO project_members (project_id, user_id, role, created_at) VALUES (?, ?, ?, ?)',
        project.id,
        ownerId,
        'owner',
        now
      );
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index]!;
        const path = paths[index]!;
        const mimeType = file.mimeType ?? String(mimeLookup(path) || 'application/octet-stream');
        this.insertFile(project.id, path, file.content, mimeType, { type: 'system', id: 'import', name: 'ZIP import' }, now);
      }
    });
    return project;
  }

  listForUser(userId: string): ProjectSummary[] {
    return this.db.all<ProjectSummary>(
      `SELECT p.*, pm.role, owner.display_name AS owner_name,
        (SELECT COUNT(*) FROM project_members members WHERE members.project_id = p.id) AS member_count,
        (SELECT status FROM compile_jobs jobs WHERE jobs.project_id = p.id ORDER BY jobs.created_at DESC LIMIT 1) AS latest_compile_status
       FROM projects p
       JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = ?
       JOIN users owner ON owner.id = p.owner_id
       ORDER BY p.updated_at DESC`,
      userId
    );
  }

  getProjectByHash(hash: string): ProjectRecord | undefined {
    return this.db.get<ProjectRecord>('SELECT * FROM projects WHERE public_hash = ?', hash);
  }

  listFiles(projectId: string): FileRecord[] {
    return this.db.all<FileRecord>('SELECT * FROM files WHERE project_id = ? ORDER BY path COLLATE NOCASE', projectId);
  }

  getFileById(fileId: string): FileRecord | undefined {
    return this.db.get<FileRecord>('SELECT * FROM files WHERE id = ?', fileId);
  }

  getFile(projectId: string, pathInput: string): FileRecord | undefined {
    return this.db.get<FileRecord>(
      'SELECT * FROM files WHERE project_id = ? AND path = ?',
      projectId,
      normalizeProjectPath(pathInput)
    );
  }

  addFile(projectId: string, pathInput: string, content: Uint8Array, mimeTypeInput: string | undefined, actor: ActorIdentity): FileRecord {
    const path = normalizeProjectPath(pathInput);
    if (this.getFile(projectId, path)) throw new HttpError(409, 'A file already exists at that path', 'file_exists');
    const mimeType = mimeTypeInput || String(mimeLookup(path) || 'application/octet-stream');
    const now = new Date().toISOString();
    const file = this.db.transaction(() => {
      const created = this.insertFile(projectId, path, content, mimeType, actor, now);
      this.touch(projectId, now);
      return created;
    });
    return file;
  }

  saveFile(
    fileId: string,
    content: Uint8Array,
    actor: ActorIdentity,
    immediateRevision = true,
    yState?: Uint8Array
  ): FileRecord {
    const existing = this.getFileById(fileId);
    if (!existing) throw new HttpError(404, 'File not found', 'file_not_found');
    const hash = fileRevision(existing.path, content);
    const yStateChanged = yState !== undefined && !buffersEqual(existing.y_state, yState);
    if (hash === existing.revision_hash && !yStateChanged) return existing;
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.run(
        'UPDATE files SET content = ?, y_state = COALESCE(?, y_state), revision_hash = ?, updated_at = ? WHERE id = ?',
        content,
        yState ?? null,
        hash,
        now,
        fileId
      );
      if (immediateRevision && hash !== existing.revision_hash) this.insertRevision(fileId, hash, content, actor, now);
      this.touch(existing.project_id, now);
    });
    return { ...existing, content, y_state: yState ?? existing.y_state, revision_hash: hash, updated_at: now };
  }

  saveYState(fileId: string, yState: Uint8Array): void {
    this.db.run('UPDATE files SET y_state = ? WHERE id = ?', yState, fileId);
  }

  addRevision(fileId: string, content: Uint8Array, actor: ActorIdentity): void {
    const file = this.getFileById(fileId);
    if (!file) throw new HttpError(404, 'File not found', 'file_not_found');
    const hash = fileRevision(file.path, content);
    const latest = this.db.get<{ revision_hash: string }>(
      'SELECT revision_hash FROM file_revisions WHERE file_id = ? ORDER BY created_at DESC LIMIT 1',
      fileId
    );
    if (latest?.revision_hash === hash) return;
    this.insertRevision(fileId, hash, content, actor, new Date().toISOString());
  }

  renameFile(fileId: string, newPathInput: string): FileRecord {
    const file = this.getFileById(fileId);
    if (!file) throw new HttpError(404, 'File not found', 'file_not_found');
    const newPath = normalizeProjectPath(newPathInput);
    const duplicate = this.getFile(file.project_id, newPath);
    if (duplicate && duplicate.id !== file.id) throw new HttpError(409, 'A file already exists at that path', 'file_exists');
    const now = new Date().toISOString();
    const hash = fileRevision(newPath, file.content);
    this.db.transaction(() => {
      this.db.run('UPDATE files SET path = ?, revision_hash = ?, updated_at = ? WHERE id = ?', newPath, hash, now, fileId);
      this.db.run(
        'UPDATE projects SET entry_file = CASE WHEN entry_file = ? THEN ? ELSE entry_file END, updated_at = ? WHERE id = ?',
        file.path,
        newPath,
        now,
        file.project_id
      );
    });
    return { ...file, path: newPath, revision_hash: hash, updated_at: now };
  }

  deleteFile(fileId: string): void {
    const file = this.getFileById(fileId);
    if (!file) throw new HttpError(404, 'File not found', 'file_not_found');
    this.db.run('DELETE FROM files WHERE id = ?', fileId);
    this.touch(file.project_id);
  }

  setEntryFile(projectId: string, pathInput: string): void {
    const path = normalizeProjectPath(pathInput);
    const file = this.getFile(projectId, path);
    if (!file || file.kind !== 'text') throw new HttpError(400, 'Entry file must be an existing text file', 'invalid_entry_file');
    this.db.run('UPDATE projects SET entry_file = ?, updated_at = ? WHERE id = ?', path, new Date().toISOString(), projectId);
  }

  compileFileMetadata(projectId: string): Array<Pick<FileRecord, 'path' | 'kind' | 'revision_hash'> & { byte_length: number }> {
    return this.db.all(
      'SELECT path, kind, revision_hash, length(content) AS byte_length FROM files WHERE project_id = ? ORDER BY path COLLATE NOCASE',
      projectId
    );
  }

  compileSources(projectId: string): Array<Pick<FileRecord, 'path' | 'content'>> {
    return this.db.all('SELECT path, content FROM files WHERE project_id = ? ORDER BY path COLLATE NOCASE', projectId);
  }

  sourceHash(projectId: string, context: string[] = [], files: ReadonlyArray<Pick<FileRecord, 'path' | 'revision_hash'>> = this.compileFileMetadata(projectId)): string {
    const hash = createHash('sha256');
    hash.update('overroot-compile-cache-v2\0');
    for (const value of context) {
      hash.update(value);
      hash.update('\0');
    }
    for (const file of files) {
      hash.update(file.path);
      hash.update('\0');
      hash.update(file.revision_hash);
      hash.update('\0');
    }
    return hash.digest('hex');
  }

  private insertFile(
    projectId: string,
    pathInput: string,
    contentInput: Uint8Array,
    mimeType: string,
    actor: ActorIdentity,
    now: string
  ): FileRecord {
    const path = normalizeProjectPath(pathInput);
    const content = Buffer.from(contentInput);
    const kind = isTextMime(mimeType, path) ? 'text' : 'binary';
    const yState = kind === 'text' ? createYState(content.toString('utf8')) : null;
    const file: FileRecord = {
      id: randomUUID(),
      project_id: projectId,
      path,
      kind,
      mime_type: mimeType,
      content,
      y_state: yState,
      revision_hash: fileRevision(path, content),
      created_at: now,
      updated_at: now
    };
    this.db.run(
      `INSERT INTO files (id, project_id, path, kind, mime_type, content, y_state, revision_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      file.id,
      file.project_id,
      file.path,
      file.kind,
      file.mime_type,
      file.content,
      file.y_state,
      file.revision_hash,
      file.created_at,
      file.updated_at
    );
    this.insertRevision(file.id, file.revision_hash, file.content, actor, now);
    return file;
  }

  private insertRevision(fileId: string, hash: string, content: Uint8Array, actor: ActorIdentity, now: string): void {
    this.db.run(
      `INSERT INTO file_revisions
        (id, file_id, revision_hash, content, actor_type, actor_id, actor_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      randomUUID(),
      fileId,
      hash,
      content,
      actor.type,
      actor.id,
      actor.name,
      now
    );
  }

  private touch(projectId: string, now = new Date().toISOString()): void {
    this.db.run('UPDATE projects SET updated_at = ? WHERE id = ?', now, projectId);
  }
}

function cleanProjectName(input: string): string {
  const name = input.trim().replace(/\s+/g, ' ');
  if (!name || name.length > 100) throw new HttpError(400, 'Project name must be 1–100 characters', 'invalid_project_name');
  return name;
}

function chooseEntryFile(paths: string[]): string {
  if (paths.includes('main.tex')) return 'main.tex';
  const rootTex = paths.find((path) => path.endsWith('.tex') && !path.includes('/'));
  return rootTex ?? paths.find((path) => path.endsWith('.tex')) ?? paths[0]!;
}

function createYState(content: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getText('content').insert(0, content);
  const state = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return state;
}

function buffersEqual(left: Uint8Array | null, right: Uint8Array): boolean {
  if (!left || left.byteLength !== right.byteLength) return false;
  return Buffer.from(left).equals(Buffer.from(right));
}
