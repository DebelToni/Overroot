import { Bot, Check, Download, Eye, FileClock, KeyRound, Pencil, Plus, RotateCcw, Trash2, UserPlus } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import type { ApiClient } from '../lib/api';
import { fileSize, relativeTime } from '../lib/format';
import type { AgentAccess, AgentCredential, FileRevision, ProjectDetail, ProjectFile, ProjectMember } from '../types';
import { CopyButton } from './CopyButton';
import { InlineError, LoadingBlock } from './Feedback';
import { Modal } from './Modal';

export function NewFileDialog({ open, onClose, onCreate }: { open: boolean; onClose: () => void; onCreate: (path: string) => Promise<void> }) {
  const [path, setPath] = useState('section.tex');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) { setPath('section.tex'); setError(null); } }, [open]);
  async function submit(event: FormEvent) { event.preventDefault(); setBusy(true); setError(null); try { await onCreate(path); onClose(); } catch (reason) { setError(message(reason)); } finally { setBusy(false); } }
  return <Modal open={open} onClose={onClose} title="Create a file" eyebrow="Project files" size="small"><form className="stack-form" onSubmit={submit}>
    <label className="field"><span>Path</span><input autoFocus value={path} onChange={(event) => setPath(event.target.value)} placeholder="chapters/introduction.tex" required/></label>
    <p className="field-help">Folders are created from the path automatically.</p><InlineError message={error}/>
    <div className="form-actions"><button className="plain-button" type="button" onClick={onClose}>Cancel</button><button className="primary-button" type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create file'}</button></div>
  </form></Modal>;
}

export function FileActionsDialog({
  open, file, entryFile, canSetEntry, onClose, onRename, onDelete, onSetEntry
}: {
  open: boolean; file: ProjectFile | null; entryFile: string; canSetEntry: boolean; onClose: () => void;
  onRename: (path: string) => Promise<void>; onDelete: () => Promise<void>; onSetEntry: () => Promise<void>;
}) {
  const [path, setPath] = useState(''); const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  useEffect(() => { setPath(file?.path ?? ''); setError(null); }, [file, open]);
  if (!file) return null;
  async function run(action: () => Promise<void>) { setBusy(true); setError(null); try { await action(); onClose(); } catch (reason) { setError(message(reason)); } finally { setBusy(false); } }
  return <Modal open={open} onClose={onClose} title={file.path.split('/').at(-1)!} eyebrow="File actions" size="small"><div className="stack-form">
    <label className="field"><span>Path</span><input value={path} onChange={(event) => setPath(event.target.value)}/></label>
    <InlineError message={error}/>
    <div className="vertical-actions">
      <button className="secondary-button" type="button" disabled={busy || path === file.path} onClick={() => void run(() => onRename(path))}><Pencil size={14}/> Rename</button>
      {canSetEntry && file.kind === 'text' && file.path !== entryFile && <button className="secondary-button" type="button" disabled={busy} onClick={() => void run(onSetEntry)}><Check size={14}/> Use as main file</button>}
      <button className="danger-button" type="button" disabled={busy || file.path === entryFile} onClick={() => { if (confirm(`Delete ${file.path}?`)) void run(onDelete); }}><Trash2 size={14}/> Delete file</button>
    </div>
    {file.path === entryFile && <p className="field-help">The main file cannot be deleted. Choose another main file first.</p>}
  </div></Modal>;
}

export function ShareDialog({ open, onClose, api, project }: { open: boolean; onClose: () => void; api: ApiClient; project: ProjectDetail }) {
  const [members, setMembers] = useState<ProjectMember[]>([]); const [username, setUsername] = useState(''); const [role, setRole] = useState<'editor' | 'viewer'>('editor');
  const [loading, setLoading] = useState(false); const [error, setError] = useState<string | null>(null);
  async function load() { setLoading(true); setError(null); try { setMembers((await api.listMembers(project.hash)).members); } catch (reason) { setError(message(reason)); } finally { setLoading(false); } }
  useEffect(() => { if (open) void load(); }, [open, project.hash]);
  async function add(event: FormEvent) { event.preventDefault(); setError(null); try { await api.addMember(project.hash, username, role); setUsername(''); await load(); } catch (reason) { setError(message(reason)); } }
  async function update(member: ProjectMember, nextRole: 'editor' | 'viewer') { await api.updateMember(project.hash, member.id, nextRole); await load(); }
  async function remove(member: ProjectMember) { if (!confirm(`Remove ${member.username} from this project?`)) return; await api.removeMember(project.hash, member.id); await load(); }
  return <Modal open={open} onClose={onClose} title="Share this project" eyebrow="People" size="large">
    <p className="dialog-copy">Editors write and compile. Viewers follow changes and read the current PDF.</p>
    {project.canManage && <form className="inline-form" onSubmit={add}><label className="field"><span>Username</span><input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="friend" required/></label><label className="field field--select"><span>Access</span><select value={role} onChange={(event) => setRole(event.target.value as 'editor' | 'viewer')}><option value="editor">Editor</option><option value="viewer">Viewer</option></select></label><button className="primary-button" type="submit"><UserPlus size={14}/> Add</button></form>}
    <InlineError message={error}/>
    {loading ? <LoadingBlock/> : <div className="rule-list">{members.map((member) => <div className="rule-row" key={member.id}>
      <span className="avatar">{member.username.slice(0, 2).toUpperCase()}</span><div><strong>{member.username}</strong><small>Added {relativeTime(member.addedAt)}</small></div>
      {member.role === 'owner' || !project.canManage ? <span className="status-label">{member.role}</span> : <select className="compact-select" value={member.role} onChange={(event) => void update(member, event.target.value as 'editor' | 'viewer')}><option value="editor">Editor</option><option value="viewer">Viewer</option></select>}
      {project.canManage && member.role !== 'owner' && <button className="icon-button icon-button--danger" type="button" onClick={() => void remove(member)} aria-label={`Remove ${member.username}`}><Trash2 size={14}/></button>}
    </div>)}</div>}
  </Modal>;
}

export function AgentDialog({ open, onClose, api, project }: { open: boolean; onClose: () => void; api: ApiClient; project: ProjectDetail }) {
  const [agents, setAgents] = useState<AgentCredential[]>([]); const [name, setName] = useState('Pi'); const [created, setCreated] = useState<AgentAccess | null>(null);
  const [loading, setLoading] = useState(false); const [error, setError] = useState<string | null>(null);
  async function load() { setLoading(true); try { setAgents((await api.listAgents(project.hash)).agents); } catch (reason) { setError(message(reason)); } finally { setLoading(false); } }
  useEffect(() => { if (open) { setCreated(null); setError(null); void load(); } }, [open, project.hash]);
  async function create(event: FormEvent) { event.preventDefault(); setError(null); try { const response = await api.createAgent(project.hash, name); setCreated(response.access); setName(''); await load(); } catch (reason) { setError(message(reason)); } }
  async function revoke(agent: AgentCredential) { if (!confirm(`Revoke ${agent.name}?`)) return; await api.revokeAgent(project.hash, agent.id); await load(); }
  return <Modal open={open} onClose={onClose} title="Agent access" eyebrow="Direct collaboration" size="large">
    <div className="dialog-intro"><p>Each password is restricted to this project. Agent edits appear live and are recorded in history.</p></div>
    <form className="inline-form inline-form--agent" onSubmit={create}><label className="field"><span>Agent name</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Research agent" required/></label><button className="primary-button" type="submit"><Plus size={14}/> Create access</button></form>
    <InlineError message={error}/>
    {created && <section className="credential-card" aria-label="New agent credential"><header><KeyRound size={15}/><strong>Copy now — the password will not be shown again.</strong></header>
      <Credential label="API base" value={created.link}/><Credential label="Project hash" value={created.projectHash}/><Credential label="Password" value={created.password} secret/><a href={created.guide} target="_blank" rel="noreferrer">Open agent guide</a>
    </section>}
    {loading ? <LoadingBlock/> : <div className="rule-list">{agents.length === 0 && <div className="empty-row">No agent credentials.</div>}{agents.map((agent) => <div className="rule-row" key={agent.id}>
      <Bot size={16}/><div><strong>{agent.name}</strong><small>{agent.revokedAt ? `Revoked ${relativeTime(agent.revokedAt)}` : `Last used ${relativeTime(agent.lastUsedAt)}`}</small></div><span className={`status-label ${!agent.revokedAt ? 'status-label--active' : ''}`}>{agent.revokedAt ? 'REVOKED' : 'ACTIVE'}</span>{!agent.revokedAt && <button className="icon-button icon-button--danger" type="button" onClick={() => void revoke(agent)} aria-label={`Revoke ${agent.name}`}><Trash2 size={14}/></button>}
    </div>)}</div>}
  </Modal>;
}

function Credential({ label, value, secret = false }: { label: string; value: string; secret?: boolean }) { return <div className="credential-line"><span>{label}</span><code className={secret ? 'credential-secret' : ''}>{value}</code><CopyButton value={value}/></div>; }

export function ProjectSettingsDialog({ open, onClose, api, project, files, onChanged, onDeleted }: { open: boolean; onClose: () => void; api: ApiClient; project: ProjectDetail; files: ProjectFile[]; onChanged: (project: ProjectDetail) => void; onDeleted: () => void }) {
  const [name, setName] = useState(project.name); const [entryFile, setEntryFile] = useState(project.entryFile); const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  useEffect(() => { setName(project.name); setEntryFile(project.entryFile); setError(null); }, [project, open]);
  async function save(event: FormEvent) { event.preventDefault(); setBusy(true); try { const response = await api.updateProject(project.hash, { name, entryFile }); onChanged(response.project); onClose(); } catch (reason) { setError(message(reason)); } finally { setBusy(false); } }
  async function exportZip() { const result = await api.exportProject(project.hash); downloadBytes(result.data, result.filename ?? `${project.name}.zip`, 'application/zip'); }
  async function remove() { if (!confirm(`Permanently delete “${project.name}”?`)) return; await api.deleteProject(project.hash); onDeleted(); }
  return <Modal open={open} onClose={onClose} title="Project settings" eyebrow="Document" size="medium"><form className="stack-form" onSubmit={save}>
    <label className="field"><span>Name</span><input value={name} onChange={(event) => setName(event.target.value)} required maxLength={100}/></label>
    <label className="field field--select"><span>Main file</span><select value={entryFile} onChange={(event) => setEntryFile(event.target.value)}>{files.filter((file) => file.kind === 'text').map((file) => <option key={file.id}>{file.path}</option>)}</select></label>
    <InlineError message={error}/><div className="form-actions"><button type="button" className="secondary-button" onClick={() => void exportZip()}><Download size={14}/> Export ZIP</button><span className="form-actions__spacer"/><button type="button" className="plain-button" onClick={onClose}>Cancel</button><button type="submit" className="primary-button" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button></div>
    <div className="danger-zone"><div><strong>Delete project</strong><span>Removes files, history, sharing, and agent access.</span></div><button type="button" className="danger-button" onClick={() => void remove()}><Trash2 size={14}/> Delete</button></div>
  </form></Modal>;
}

export function HistoryDrawer({ open, onClose, api, projectHash, file, canWrite, refreshKey }: { open: boolean; onClose: () => void; api: ApiClient; projectHash: string; file: ProjectFile | null; canWrite: boolean; refreshKey: number }) {
  const [revisions, setRevisions] = useState<FileRevision[]>([]); const [selected, setSelected] = useState<(FileRevision & { content?: string }) | null>(null); const [loading, setLoading] = useState(false); const [error, setError] = useState<string | null>(null);
  async function load() { if (!file) return; setLoading(true); try { setRevisions((await api.listRevisions(projectHash, file.id)).revisions); } catch (reason) { setError(message(reason)); } finally { setLoading(false); } }
  useEffect(() => { if (open) { setSelected(null); void load(); } }, [open, file?.id, refreshKey]);
  async function view(revision: FileRevision) { const response = await api.getRevision(projectHash, file!.id, revision.id); setSelected({ ...revision, content: response.revision.content }); }
  async function restore() { if (!selected || !file) return; await api.restoreRevision(projectHash, file.id, selected.id); setSelected(null); await load(); }
  return <aside className={`drawer history-drawer ${open ? 'is-open' : ''}`} aria-hidden={!open} aria-label="File history"><header><div><div className="eyebrow">Version history</div><h2>{file?.path ?? 'No file selected'}</h2></div><button className="icon-button" type="button" onClick={onClose} aria-label="Close history">×</button></header>
    <InlineError message={error}/>{loading ? <LoadingBlock/> : selected ? <div className="revision-preview"><button className="plain-button" type="button" onClick={() => setSelected(null)}>← All revisions</button><div className="revision-preview__meta"><strong>{selected.actorName}</strong><span>{new Date(selected.createdAt).toLocaleString()}</span></div><pre>{selected.content ?? 'Binary revision'}</pre>{canWrite && <button className="primary-button" type="button" onClick={() => void restore()}><RotateCcw size={14}/> Restore this revision</button>}</div> : <div className="revision-list">{revisions.length === 0 && <div className="empty-row">No revisions yet.</div>}{revisions.map((revision) => <button type="button" key={revision.id} onClick={() => void view(revision)}><span className={`actor-mark actor-mark--${revision.actorType}`}>{revision.actorType === 'agent' ? <Bot size={13}/> : <FileClock size={13}/>}</span><span><strong>{revision.actorName}</strong><small>{relativeTime(revision.createdAt)} · {fileSize(revision.size)}</small></span><Eye size={14}/></button>)}</div>}
  </aside>;
}

export function CompileLogDrawer({ open, onClose, status, log, error }: { open: boolean; onClose: () => void; status: string; log: string; error: string | null }) {
  return <aside className={`drawer log-drawer ${open ? 'is-open' : ''}`} aria-hidden={!open}><header><div><div className="eyebrow">Compiler output</div><h2>{status}</h2></div><button className="icon-button" type="button" onClick={onClose} aria-label="Close compile log">×</button></header>{error && <InlineError message={error}/>}<pre>{log || 'No compiler output yet.'}</pre></aside>;
}

function message(reason: unknown) { return reason instanceof Error ? reason.message : 'Something went wrong'; }
function downloadBytes(data: ArrayBuffer, filename: string, type: string) { const url = URL.createObjectURL(new Blob([data], { type })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
