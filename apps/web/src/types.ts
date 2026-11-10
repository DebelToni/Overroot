export interface User {
  id: string;
  username: string;
  displayName: string;
  isAdmin: boolean;
  createdAt: string;
}

export type Role = 'owner' | 'editor' | 'viewer' | 'agent';

export interface ProjectSummary {
  hash: string;
  name: string;
  entryFile: string;
  role: Exclude<Role, 'agent'>;
  owner: string;
  memberCount: number;
  latestCompileStatus: CompileStatus | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectDetail {
  hash: string;
  name: string;
  entryFile: string;
  owner: string;
  role: Role;
  canWrite: boolean;
  canManage: boolean;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
  latestCompile: {
    id: string;
    status: CompileStatus;
    finishedAt: string | null;
    hasPdf: boolean;
  } | null;
}

export interface Template {
  id: string;
  name: string;
  description: string;
  entryFile: string;
}

export interface PosterOptions {
  subtitle: string;
  authors: string;
  affiliation: string;
  size: 'A0' | 'A1' | 'custom';
  orientation: 'landscape' | 'portrait';
  widthMm?: number;
  heightMm?: number;
  columns: 2 | 3 | 4;
}

export interface ProjectFile {
  id: string;
  path: string;
  kind: 'text' | 'binary';
  mimeType: string;
  revision: string;
  size: number;
  createdAt: string;
  updatedAt: string;
  content?: string;
  contentBase64?: string;
}

export type CompileStatus = 'queued' | 'compiling' | 'succeeded' | 'failed' | 'cancelled';

export interface CompileJob {
  id: string;
  sourceHash: string;
  status: CompileStatus;
  entryFile: string;
  log: string;
  error: string | null;
  requestedBy: { type: 'user' | 'agent' | 'system'; id: string; name: string };
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  hasPdf: boolean;
  hasSynctex: boolean;
}

export interface SyncTexHighlight {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SourceLocation {
  path: string;
  line: number;
}

export interface ProjectMember {
  id: string;
  username: string;
  displayName: string;
  role: Exclude<Role, 'agent'>;
  addedAt: string;
}

export interface AgentCredential {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface AgentAccess {
  link: string;
  projectHash: string;
  password: string;
  guide: string;
}

export interface FileRevision {
  id: string;
  revision: string;
  actorType: 'user' | 'agent' | 'system';
  actorId: string;
  actorName: string;
  createdAt: string;
  size: number;
}

export interface ProjectEvent {
  type: string;
  at: string;
  fileId?: string;
  path?: string;
  revision?: string;
  actor?: { type: 'user' | 'agent' | 'system'; id: string; name: string };
  job?: CompileJob;
  [key: string]: unknown;
}

export type ThemePreference = 'light' | 'dark' | 'system';
