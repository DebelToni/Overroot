import type {
  AgentAccess,
  AgentCredential,
  CompileJob,
  FileRevision,
  ProjectDetail,
  ProjectFile,
  ProjectMember,
  ProjectSummary,
  SyncTexHighlight,
  Template,
  User
} from '../types';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export class ApiClient {
  constructor(
    readonly baseUrl: string,
    private readonly getToken: () => string | null,
    private readonly onUnauthorized?: () => void,
    private readonly onNetworkError?: () => void
  ) {}

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/json');
    const token = this.getToken();
    if (token) headers.set('Authorization', `Bearer ${token}`);
    if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    let response: Response;
    try {
      response = await fetch(this.url(path), { ...init, headers });
    } catch {
      this.onNetworkError?.();
      throw new ApiError(0, 'network_error', 'The Overroot server could not be reached');
    }
    if (response.status === 401) this.onUnauthorized?.();
    if (!response.ok) throw await parseError(response);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  async bytes(path: string): Promise<{ data: ArrayBuffer; etag: string | null; filename: string | null }> {
    const headers = new Headers({ Accept: '*/*' });
    const token = this.getToken();
    if (token) headers.set('Authorization', `Bearer ${token}`);
    let response: Response;
    try {
      response = await fetch(this.url(path), { headers });
    } catch {
      this.onNetworkError?.();
      throw new ApiError(0, 'network_error', 'The Overroot server could not be reached');
    }
    if (response.status === 401) this.onUnauthorized?.();
    if (!response.ok) throw await parseError(response);
    return {
      data: await response.arrayBuffer(),
      etag: response.headers.get('etag'),
      filename: filenameFromDisposition(response.headers.get('content-disposition'))
    };
  }

  websocketUrl(path: string, ticket: string): string {
    const url = new URL(path, `${this.baseUrl}/`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('ticket', ticket);
    return url.toString();
  }

  login(username: string, password: string) {
    return this.request<{ token: string; user: User }>('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password })
    });
  }

  register(invite: string, username: string, password: string) {
    return this.request<{ token: string; user: User }>('/api/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify({ invite, username, password })
    });
  }

  me() {
    return this.request<{ user: User }>('/api/v1/auth/me');
  }

  logout() {
    return this.request<void>('/api/v1/auth/logout', { method: 'POST' });
  }

  changePassword(currentPassword: string, newPassword: string) {
    return this.request<void>('/api/v1/auth/password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword })
    });
  }

  listProjects() {
    return this.request<{ projects: ProjectSummary[] }>('/api/v1/projects');
  }

  listTemplates() {
    return this.request<{ templates: Template[] }>('/api/v1/templates');
  }

  createProject(name: string, template: string) {
    return this.request<{ project: ProjectDetail }>('/api/v1/projects', {
      method: 'POST',
      body: JSON.stringify({ name, template })
    });
  }

  importProject(file: File) {
    const body = new FormData();
    body.append('file', file);
    return this.request<{ project: ProjectDetail }>('/api/v1/projects/import', { method: 'POST', body });
  }

  getProject(hash: string) {
    return this.request<{ project: ProjectDetail }>(`/api/v1/projects/${encodeURIComponent(hash)}`);
  }

  updateProject(hash: string, change: { name?: string; entryFile?: string }) {
    return this.request<{ project: ProjectDetail }>(`/api/v1/projects/${encodeURIComponent(hash)}`, {
      method: 'PATCH',
      body: JSON.stringify(change)
    });
  }

  deleteProject(hash: string) {
    return this.request<void>(`/api/v1/projects/${encodeURIComponent(hash)}`, { method: 'DELETE' });
  }

  listFiles(hash: string) {
    return this.request<{ files: ProjectFile[] }>(`/api/v1/projects/${encodeURIComponent(hash)}/files`);
  }

  getFile(hash: string, fileId: string) {
    return this.request<{ file: ProjectFile }>(
      `/api/v1/projects/${encodeURIComponent(hash)}/files/${encodeURIComponent(fileId)}`
    );
  }

  createFile(hash: string, input: { path: string; content?: string; contentBase64?: string; mimeType?: string }) {
    return this.request<{ file: ProjectFile }>(`/api/v1/projects/${encodeURIComponent(hash)}/files`, {
      method: 'POST',
      body: JSON.stringify(input)
    });
  }

  renameFile(hash: string, fileId: string, path: string) {
    return this.request<{ file: ProjectFile }>(
      `/api/v1/projects/${encodeURIComponent(hash)}/files/${encodeURIComponent(fileId)}`,
      { method: 'PATCH', body: JSON.stringify({ path }) }
    );
  }

  deleteFile(hash: string, fileId: string) {
    return this.request<void>(`/api/v1/projects/${encodeURIComponent(hash)}/files/${encodeURIComponent(fileId)}`, {
      method: 'DELETE'
    });
  }

  listRevisions(hash: string, fileId: string) {
    return this.request<{ revisions: FileRevision[] }>(
      `/api/v1/projects/${encodeURIComponent(hash)}/files/${encodeURIComponent(fileId)}/revisions`
    );
  }

  getRevision(hash: string, fileId: string, revisionId: string) {
    return this.request<{ revision: FileRevision & { content?: string; contentBase64?: string } }>(
      `/api/v1/projects/${encodeURIComponent(hash)}/files/${encodeURIComponent(fileId)}/revisions/${encodeURIComponent(revisionId)}`
    );
  }

  restoreRevision(hash: string, fileId: string, revisionId: string) {
    return this.request<{ file: ProjectFile }>(
      `/api/v1/projects/${encodeURIComponent(hash)}/files/${encodeURIComponent(fileId)}/revisions/${encodeURIComponent(revisionId)}/restore`,
      { method: 'POST' }
    );
  }

  compile(hash: string) {
    return this.request<{ job: CompileJob }>(`/api/v1/projects/${encodeURIComponent(hash)}/compile`, { method: 'POST' });
  }

  latestCompile(hash: string) {
    return this.request<{ job: CompileJob | null }>(`/api/v1/projects/${encodeURIComponent(hash)}/compile/latest`);
  }

  compilePdf(hash: string, jobId: string) {
    return this.bytes(`/api/v1/projects/${encodeURIComponent(hash)}/compile/${encodeURIComponent(jobId)}/pdf`);
  }

  locateSource(hash: string, jobId: string, path: string, line: number) {
    const query = new URLSearchParams({ path, line: String(line) });
    return this.request<{
      source: { path: string; line: number; mappedLine: number | null };
      highlights: SyncTexHighlight[];
    }>(`/api/v1/projects/${encodeURIComponent(hash)}/compile/${encodeURIComponent(jobId)}/synctex?${query}`);
  }

  latestPdf(hash: string) {
    return this.bytes(`/api/v1/projects/${encodeURIComponent(hash)}/pdf`);
  }

  exportProject(hash: string) {
    return this.bytes(`/api/v1/projects/${encodeURIComponent(hash)}/export.zip`);
  }

  listMembers(hash: string) {
    return this.request<{ members: ProjectMember[] }>(`/api/v1/projects/${encodeURIComponent(hash)}/members`);
  }

  addMember(hash: string, username: string, role: 'editor' | 'viewer') {
    return this.request<{ member: ProjectMember }>(`/api/v1/projects/${encodeURIComponent(hash)}/members`, {
      method: 'POST',
      body: JSON.stringify({ username, role })
    });
  }

  updateMember(hash: string, userId: string, role: 'editor' | 'viewer') {
    return this.request<{ ok: true }>(
      `/api/v1/projects/${encodeURIComponent(hash)}/members/${encodeURIComponent(userId)}`,
      { method: 'PATCH', body: JSON.stringify({ role }) }
    );
  }

  removeMember(hash: string, userId: string) {
    return this.request<void>(`/api/v1/projects/${encodeURIComponent(hash)}/members/${encodeURIComponent(userId)}`, {
      method: 'DELETE'
    });
  }

  searchUsers(query: string) {
    return this.request<{ users: User[] }>(`/api/v1/users?q=${encodeURIComponent(query)}`);
  }

  listAgents(hash: string) {
    return this.request<{ agents: AgentCredential[] }>(`/api/v1/projects/${encodeURIComponent(hash)}/agents`);
  }

  createAgent(hash: string, name: string) {
    return this.request<{ agent: AgentCredential; access: AgentAccess }>(
      `/api/v1/projects/${encodeURIComponent(hash)}/agents`,
      { method: 'POST', body: JSON.stringify({ name }) }
    );
  }

  revokeAgent(hash: string, agentId: string) {
    return this.request<void>(
      `/api/v1/projects/${encodeURIComponent(hash)}/agents/${encodeURIComponent(agentId)}`,
      { method: 'DELETE' }
    );
  }

  createWsTicket(projectHash: string, channel: 'file' | 'events', fileId?: string) {
    return this.request<{ ticket: string; path: string; expiresAt: string }>('/api/v1/ws-ticket', {
      method: 'POST',
      body: JSON.stringify({ projectHash, channel, ...(fileId ? { fileId } : {}) })
    });
  }

  listInvites() {
    return this.request<{ invites: InviteSummary[] }>('/api/v1/admin/invites');
  }

  createInvite(expiresInDays = 7) {
    return this.request<CreatedInvite>('/api/v1/admin/invites', {
      method: 'POST',
      body: JSON.stringify({ expiresInDays })
    });
  }

  deleteInvite(id: string) {
    return this.request<void>(`/api/v1/admin/invites/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  private url(path: string): string {
    return new URL(path, `${this.baseUrl}/`).toString();
  }
}

export interface InviteSummary {
  id: string;
  expiresAt: string;
  usedAt: string | null;
  createdAt: string;
  createdBy: string;
  usedBy: string | null;
}

export interface CreatedInvite {
  id: string;
  token: string;
  expiresAt: string;
  registrationUrl: string;
}

async function parseError(response: Response): Promise<ApiError> {
  try {
    const payload = (await response.json()) as { error?: { code?: string; message?: string; details?: unknown } };
    return new ApiError(
      response.status,
      payload.error?.code ?? 'request_error',
      payload.error?.message ?? `Request failed with ${response.status}`,
      payload.error?.details
    );
  } catch {
    return new ApiError(response.status, 'request_error', `Request failed with ${response.status}`);
  }
}

function filenameFromDisposition(value: string | null): string | null {
  if (!value) return null;
  return value.match(/filename="?([^";]+)"?/i)?.[1] ?? null;
}
