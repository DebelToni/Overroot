import {
  ArrowLeft, Bot, Braces, Download, FileText, History, LogOut, Menu, PanelLeftClose,
  MoreHorizontal, PanelLeftOpen, Play, Settings2, Users
} from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Brand } from '../components/Brand';
import type { PresenceUser } from '../components/EditorPane';
import { FileTree } from '../components/FileTree';
import { InlineError, LoadingBlock } from '../components/Feedback';
import { ThemeControl } from '../components/ThemeControl';
import { Modal } from '../components/Modal';
import {
  AgentDialog, CompileLogDrawer, FileActionsDialog, HistoryDrawer, NewFileDialog,
  ProjectSettingsDialog, ShareDialog
} from '../components/WorkspaceDialogs';
import { useProjectEvents } from '../hooks/useProjectEvents';
import { useTheme } from '../hooks/useTheme';
import { ApiError } from '../lib/api';
import { initials, relativeTime } from '../lib/format';
import { useSession } from '../lib/session';
import {
  loadEditorPercent, loadTreeOpen, MAX_EDITOR_PERCENT, MIN_EDITOR_PERCENT,
  storeEditorPercent, storeTreeOpen
} from '../lib/workspace-state';
import type { CompileJob, ProjectDetail, ProjectEvent, ProjectFile, SourceLocation } from '../types';

const EditorPane = lazy(() => import('../components/EditorPane').then((module) => ({ default: module.EditorPane })));
const ManuscriptPane = lazy(() => import('../components/ManuscriptPane').then((module) => ({ default: module.ManuscriptPane })));
const PdfViewer = lazy(() => import('../components/PdfViewer').then((module) => ({ default: module.PdfViewer })));

export function WorkspacePage() {
  const { hash = '' } = useParams();
  const navigate = useNavigate();
  const { api, user, clearSession } = useSession();
  const theme = useTheme();
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [selected, setSelected] = useState<ProjectFile | null>(null);
  const [editorMode, setEditorMode] = useState<'manuscript' | 'files'>('manuscript');
  const [job, setJob] = useState<CompileJob | null>(null);
  const [pdf, setPdf] = useState<ArrayBuffer | null>(null);
  const [pdfRevision, setPdfRevision] = useState<string | null>(null);
  const [pdfJobId, setPdfJobId] = useState<string | null>(null);
  const [sourceLocation, setSourceLocation] = useState<SourceLocation | null>(null);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activity, setActivity] = useState<string | null>(null);
  const [presence, setPresence] = useState<PresenceUser[]>([]);
  const [historyKey, setHistoryKey] = useState(0);
  const [treeOpen, setTreeOpen] = useState(loadTreeOpen);
  const [mobilePane, setMobilePane] = useState<'files' | 'editor' | 'pdf'>('editor');
  const [editorPercent, setEditorPercent] = useState(loadEditorPercent);
  const [focusPdf, setFocusPdf] = useState(false);
  const [newFileOpen, setNewFileOpen] = useState(false);
  const [fileActions, setFileActions] = useState<ProjectFile | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const activityTimer = useRef<number | null>(null);
  const pdfRequest = useRef(0);
  const selectionRequest = useRef(0);
  const editorFlush = useRef<(() => Promise<void>) | null>(null);

  const flashActivity = useCallback((text: string) => {
    setActivity(text);
    if (activityTimer.current != null) clearTimeout(activityTimer.current);
    activityTimer.current = window.setTimeout(() => setActivity(null), 4500);
  }, []);

  const loadFiles = useCallback(async (preferredId?: string) => {
    const response = await api.listFiles(hash);
    setFiles(response.files);
    const currentId = preferredId ?? selected?.id;
    let next = response.files.find((file) => file.id === currentId);
    if (!next && project) next = response.files.find((file) => file.path === project.entryFile);
    next ??= response.files[0];
    if (next && next.id !== selected?.id) {
      const requestId = ++selectionRequest.current;
      const full = await api.getFile(hash, next.id);
      if (requestId === selectionRequest.current) setSelected(full.file);
    } else if (next) {
      setSelected((current) => current?.id === next!.id ? { ...current, ...next } : current);
    } else setSelected(null);
  }, [api, hash, project?.entryFile, selected?.id]);

  const loadPdf = useCallback(async (nextJob: CompileJob) => {
    if (!nextJob.hasPdf) return;
    const requestId = ++pdfRequest.current;
    setPdfLoading(true);
    try {
      const result = await api.compilePdf(hash, nextJob.id);
      if (requestId !== pdfRequest.current) return;
      setPdf(result.data);
      setPdfRevision(nextJob.sourceHash);
      setPdfJobId(nextJob.hasSynctex ? nextJob.id : null);
    } catch (reason) {
      if (requestId === pdfRequest.current) setError(reason instanceof Error ? reason.message : 'Could not load PDF');
    } finally {
      if (requestId === pdfRequest.current) setPdfLoading(false);
    }
  }, [api, hash]);

  const loadProject = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [projectResponse, fileResponse, compileResponse] = await Promise.all([
        api.getProject(hash), api.listFiles(hash), api.latestCompile(hash)
      ]);
      setProject(projectResponse.project);
      setFiles(fileResponse.files);
      setJob(compileResponse.job);
      const initial = fileResponse.files.find((file) => file.path === projectResponse.project.entryFile) ?? fileResponse.files[0];
      if (initial) setSelected((await api.getFile(hash, initial.id)).file);
      if (compileResponse.job?.status === 'succeeded' && compileResponse.job.hasPdf) await loadPdf(compileResponse.job);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not open project'); }
    finally { setLoading(false); }
  }, [api, hash, loadPdf]);

  const reconcile = useCallback(async () => {
    try {
      const [projectResponse, compileResponse] = await Promise.all([api.getProject(hash), api.latestCompile(hash)]);
      setProject(projectResponse.project);
      setJob(compileResponse.job);
      await loadFiles();
      if (compileResponse.job?.status === 'succeeded' && compileResponse.job.hasPdf && compileResponse.job.sourceHash !== pdfRevision) {
        await loadPdf(compileResponse.job);
      }
    } catch (reason) {
      if (reason instanceof ApiError && (reason.status === 403 || reason.status === 404)) navigate('/');
      else setError(reason instanceof Error ? reason.message : 'Could not refresh the project');
    }
  }, [api, hash, loadFiles, loadPdf, navigate, pdfRevision]);

  useEffect(() => { void loadProject(); }, [loadProject]);
  useEffect(() => () => { if (activityTimer.current != null) clearTimeout(activityTimer.current); }, []);

  const handleEvent = useCallback((event: ProjectEvent) => {
    if (event.type === 'connected') {
      if (event.reconnected) void reconcile();
      return;
    }
    if (event.type.startsWith('compile.') && event.job) {
      setJob(event.job);
      if (event.type === 'compile.ready') void loadPdf(event.job);
      if (event.type === 'compile.failed') setLogOpen(true);
    }
    if (event.type === 'file.created' || event.type === 'file.deleted' || event.type === 'file.renamed') {
      void loadFiles();
      if (event.type === 'file.renamed') void api.getProject(hash).then((response) => setProject(response.project));
    }
    if (event.type === 'file.changed' || event.type === 'agent.changed') {
      setHistoryKey((value) => value + 1);
      if (event.actor) flashActivity(`${event.actor.name} updated ${event.path ?? 'a file'}`);
      const selectedId = selected?.id;
      if (!project?.canWrite && selectedId && selectedId === event.fileId) {
        const requestId = ++selectionRequest.current;
        void api.getFile(hash, selectedId).then((response) => {
          if (requestId === selectionRequest.current) setSelected(response.file);
        });
      }
    }
    if (event.type === 'project.updated' || event.type === 'members.changed') void reconcile();
  }, [api, hash, loadFiles, loadPdf, flashActivity, project?.canWrite, reconcile, selected?.id]);
  useProjectEvents(api, hash, handleEvent);

  useEffect(() => {
    if (!job || (job.status !== 'queued' && job.status !== 'compiling')) return;
    const timer = window.setInterval(() => {
      void api.latestCompile(hash).then(({ job: latest }) => {
        if (!latest) return;
        setJob(latest);
        if (latest.status === 'succeeded' && latest.hasPdf) void loadPdf(latest);
        if (latest.status === 'failed') setLogOpen(true);
      });
    }, 1400);
    return () => window.clearInterval(timer);
  }, [api, hash, job?.status, loadPdf]);

  const onPresence = useCallback((users: PresenceUser[]) => setPresence(users), []);
  const onCursorChange = useCallback((location: SourceLocation | null) => setSourceLocation(location), []);

  async function selectFile(file: ProjectFile) {
    setError(null);
    const requestId = ++selectionRequest.current;
    try {
      await editorFlush.current?.();
      const response = await api.getFile(hash, file.id);
      if (requestId === selectionRequest.current) {
        setSelected(response.file);
        setEditorMode('files');
        setMobilePane('editor');
      }
    } catch (reason) {
      if (requestId === selectionRequest.current) setError(reason instanceof Error ? reason.message : 'Could not open file');
    }
  }

  async function switchEditorMode(mode: 'manuscript' | 'files') {
    if (mode === editorMode) return;
    try {
      await editorFlush.current?.();
      setEditorMode(mode);
    } catch { setError('Wait for the editor to synchronize before switching views. Your edits are still in the current view.'); }
  }

  async function createFile(path: string) {
    const response = await api.createFile(hash, { path, content: '' });
    await loadFiles(response.file.id);
  }

  async function uploadFiles(list: FileList) {
    setError(null);
    for (const source of Array.from(list)) {
      try {
        const text = isTextUpload(source) ? await source.text() : undefined;
        const base64 = text == null ? toBase64(await source.arrayBuffer()) : undefined;
        const response = await api.createFile(hash, { path: source.name, ...(text != null ? { content: text } : { contentBase64: base64 }), mimeType: source.type || undefined });
        await loadFiles(response.file.id);
      } catch (reason) { setError(`${source.name}: ${reason instanceof Error ? reason.message : 'upload failed'}`); break; }
    }
  }

  async function compile() {
    setError(null);
    try {
      await editorFlush.current?.();
      const response = await api.compile(hash);
      setJob(response.job);
      if (response.job.status === 'succeeded') await loadPdf(response.job);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not compile'); }
  }

  async function exportZip() {
    try {
      const result = await api.exportProject(hash);
      const url = URL.createObjectURL(new Blob([result.data], { type: 'application/zip' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = result.filename ?? `${project?.name ?? 'overroot-project'}.zip`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not export project');
    }
  }

  async function logout() { try { await api.logout(); } catch { /* Clear the local session even if the server disappeared. */ } clearSession(); navigate('/login'); }

  const onFlushReady = useCallback((flush: (() => Promise<void>) | null) => { editorFlush.current = flush; }, []);

  function toggleTree() {
    const next = !treeOpen;
    setTreeOpen(next);
    storeTreeOpen(next);
  }

  function resizeStart(event: React.PointerEvent) {
    const container = workspaceRef.current;
    if (!container) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const bounds = container.getBoundingClientRect();
    let latestPercent = editorPercent;
    const move = (next: PointerEvent) => {
      latestPercent = Math.min(MAX_EDITOR_PERCENT, Math.max(MIN_EDITOR_PERCENT, ((next.clientX - bounds.left) / bounds.width) * 100));
      setEditorPercent(latestPercent);
    };
    const done = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', done);
      window.removeEventListener('pointercancel', done);
      storeEditorPercent(latestPercent);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', done);
    window.addEventListener('pointercancel', done);
  }

  if (loading) return <div className="workspace-loading"><Brand/><LoadingBlock label="Opening project"/></div>;
  if (!project || !user) return <div className="workspace-loading"><Brand/><InlineError message={error ?? 'Project not found'}/><button className="plain-button" onClick={() => navigate('/')}>Back to projects</button></div>;

  const compiling = job?.status === 'queued' || job?.status === 'compiling';
  return <div className={`workspace-shell ${focusPdf ? 'workspace-shell--pdf-focus' : ''}`} data-mobile-pane={mobilePane}>
    <header className="workspace-head">
      <button className="icon-button workspace-back" type="button" onClick={() => navigate('/')} aria-label="Back to projects"><ArrowLeft size={17}/></button>
      <Brand subtitle={project.name} compact/>
      <div className="project-crumb"><span>{project.name}</span><small>{project.role.toUpperCase()} · {project.entryFile}</small></div>
      <div className="presence-stack" aria-label="Active collaborators">{presence.slice(0, 4).map((person) => <span key={person.clientId} className="presence-avatar" style={{ '--person-color': person.color } as React.CSSProperties} title={person.name}>{initials(person.name)}</span>)}{presence.length > 4 && <span className="presence-more">+{presence.length - 4}</span>}</div>
      {activity && <div className="live-activity"><Bot size={13}/>{activity}</div>}
      <div className="workspace-actions">
        <button className="plain-button workspace-action-text" type="button" onClick={() => setHistoryOpen(true)}><History size={14}/> History</button>
        <button className="icon-button" type="button" onClick={() => void exportZip()} aria-label="Export project ZIP" title="Export ZIP"><Download size={15}/></button>
        <button className="plain-button workspace-action-text" type="button" onClick={() => setShareOpen(true)}><Users size={14}/> Share</button>
        {project.canManage && <button className="plain-button workspace-action-text" type="button" onClick={() => setAgentOpen(true)}><Braces size={14}/> Agents</button>}
        {project.canManage && <button className="icon-button" type="button" onClick={() => setSettingsOpen(true)} aria-label="Project settings"><Settings2 size={15}/></button>}
        <ThemeControl value={theme.preference} onChange={theme.setPreference}/>
        <button className="compile-button" type="button" disabled={!project.canWrite || compiling} onClick={() => void compile()}><Play size={14} fill="currentColor"/>{compiling ? 'Compiling…' : 'Compile'}</button>
        <button className="icon-button desktop-logout" type="button" onClick={() => void logout()} aria-label="Log out"><LogOut size={15}/></button>
        <button className="icon-button mobile-more-button" type="button" onClick={() => setMobileMenuOpen(true)} aria-label="More workspace actions"><MoreHorizontal size={17}/></button>
      </div>
    </header>
    <div className={`compile-progress compile-progress--${job?.status ?? 'idle'}`}><i/></div>
    <div className="mobile-tabs" role="tablist" aria-label="Workspace panes">
      <button role="tab" aria-selected={mobilePane === 'files'} onClick={() => setMobilePane('files')}><Menu size={14}/> Files</button>
      <button role="tab" aria-selected={mobilePane === 'editor'} onClick={() => setMobilePane('editor')}><Braces size={14}/> Edit</button>
      <button role="tab" aria-selected={mobilePane === 'pdf'} onClick={() => setMobilePane('pdf')}><FileText size={14}/> PDF</button>
    </div>
    <main className="workspace-body">
      <button className="tree-toggle" type="button" onClick={toggleTree} aria-label={treeOpen ? 'Hide file tree' : 'Show file tree'}>{treeOpen ? <PanelLeftClose size={15}/> : <PanelLeftOpen size={15}/>}</button>
      <div className={`workspace-tree-wrap ${treeOpen ? '' : 'is-collapsed'}`}>
        <FileTree files={files} selectedId={selected?.id ?? null} entryFile={project.entryFile} canWrite={project.canWrite} onSelect={(file) => void selectFile(file)} onCreate={() => setNewFileOpen(true)} onUpload={(items) => void uploadFiles(items)} onFileMenu={setFileActions}/>
      </div>
      <div ref={workspaceRef} className="editor-pdf" style={{ '--editor-percent': `${editorPercent}%` } as React.CSSProperties}>
        <div className="editor-wrap">
          <div className="editor-mode" role="group" aria-label="Source view">
            <button type="button" aria-pressed={editorMode === 'manuscript'} onClick={() => void switchEditorMode('manuscript')}>Manuscript</button>
            <button type="button" aria-pressed={editorMode === 'files'} onClick={() => void switchEditorMode('files')}>Files</button>
          </div>
          <Suspense fallback={<LoadingBlock label="Loading editor"/>}>{editorMode === 'manuscript'
            ? <ManuscriptPane api={api} projectHash={hash} entryFile={project.entryFile} files={files} user={user} canWrite={project.canWrite} dark={theme.resolved === 'dark'} refreshKey={historyKey} onPresence={onPresence} onFlushReady={onFlushReady} onCursorChange={onCursorChange}/>
            : <EditorPane api={api} projectHash={hash} file={selected} user={user} canWrite={project.canWrite} dark={theme.resolved === 'dark'} onPresence={onPresence} onFlushReady={onFlushReady} onCursorChange={onCursorChange}/>}</Suspense>
        </div>
        <div className="split-handle" role="separator" aria-orientation="vertical" onPointerDown={resizeStart}/>
        <div className="pdf-wrap"><Suspense fallback={<LoadingBlock label="Loading PDF viewer"/>}><PdfViewer key={hash} api={api} projectHash={hash} data={pdf} revision={pdfRevision} synctexJobId={pdfJobId} sourceLocation={sourceLocation} loading={pdfLoading || compiling} focusMode={focusPdf} onFocusMode={setFocusPdf} projectName={project.name}/></Suspense></div>
      </div>
    </main>
    <footer className="workspace-status">
      <button type="button" onClick={() => setLogOpen(true)} className={`compile-state compile-state--${job?.status ?? 'idle'}`}><i/>{job ? job.status : 'Not compiled'}{job?.finishedAt && <span> · {relativeTime(job.finishedAt)}</span>}</button>
      <span>{editorMode === 'manuscript' ? `Manuscript${sourceLocation ? ` · ${sourceLocation.path}:${sourceLocation.line}` : ''}` : selected ? `${selected.path} · ${selected.kind}` : 'No file selected'}</span><span className="workspace-status__spacer"/><span>{project.memberCount} member{project.memberCount === 1 ? '' : 's'}</span>
    </footer>
    <InlineError message={error}/>

    <NewFileDialog open={newFileOpen} onClose={() => setNewFileOpen(false)} onCreate={createFile}/>
    <FileActionsDialog open={Boolean(fileActions)} file={fileActions} entryFile={project.entryFile} canSetEntry={project.canManage} onClose={() => setFileActions(null)} onRename={async (path) => { const response = await api.renameFile(hash, fileActions!.id, path); if (selected?.id === fileActions!.id) setSelected({ ...selected, ...response.file }); await loadFiles(fileActions!.id); setProject((await api.getProject(hash)).project); }} onDelete={async () => { const id = fileActions!.id; await api.deleteFile(hash, id); if (selected?.id === id) setSelected(null); await loadFiles(); }} onSetEntry={async () => { const response = await api.updateProject(hash, { entryFile: fileActions!.path }); setProject(response.project); }}/>
    <ShareDialog open={shareOpen} onClose={() => setShareOpen(false)} api={api} project={project}/>
    {project.canManage && <AgentDialog open={agentOpen} onClose={() => setAgentOpen(false)} api={api} project={project}/>} 
    {project.canManage && <ProjectSettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} api={api} project={project} files={files} onChanged={setProject} onDeleted={() => navigate('/')}/>} 
    <HistoryDrawer open={historyOpen} onClose={() => setHistoryOpen(false)} api={api} projectHash={hash} file={editorMode === 'manuscript' ? files.find((file) => file.path === sourceLocation?.path) ?? selected : selected} canWrite={project.canWrite} refreshKey={historyKey}/>
    <CompileLogDrawer open={logOpen} onClose={() => setLogOpen(false)} status={job?.status ?? 'Not compiled'} log={job?.log ?? ''} error={job?.error ?? null}/>
    <Modal open={mobileMenuOpen} onClose={() => setMobileMenuOpen(false)} title={project.name} eyebrow="Workspace actions" size="small"><div className="mobile-action-list">
      <button type="button" onClick={() => { setMobileMenuOpen(false); setHistoryOpen(true); }}><History size={16}/><span><strong>History</strong><small>Review and restore file revisions</small></span></button>
      <button type="button" onClick={() => { setMobileMenuOpen(false); setShareOpen(true); }}><Users size={16}/><span><strong>Share</strong><small>Manage project collaborators</small></span></button>
      {project.canManage && <button type="button" onClick={() => { setMobileMenuOpen(false); setAgentOpen(true); }}><Braces size={16}/><span><strong>Agent access</strong><small>Create project-scoped credentials</small></span></button>}
      <button type="button" onClick={() => { setMobileMenuOpen(false); void exportZip(); }}><Download size={16}/><span><strong>Export ZIP</strong><small>Download all project source files</small></span></button>
      {project.canManage && <button type="button" onClick={() => { setMobileMenuOpen(false); setSettingsOpen(true); }}><Settings2 size={16}/><span><strong>Project settings</strong><small>Name, main file, and deletion</small></span></button>}
      <div className="mobile-theme-row"><span><strong>Appearance</strong><small>Light, system, or dark</small></span><ThemeControl value={theme.preference} onChange={theme.setPreference}/></div>
      <button type="button" className="mobile-logout-action" onClick={() => void logout()}><LogOut size={16}/><span><strong>Log out</strong><small>End this local session</small></span></button>
    </div></Modal>
  </div>;
}

function isTextUpload(file: File) { return file.type.startsWith('text/') || /\.(tex|bib|sty|cls|txt|md|csv|json|ya?ml|xml|svg|tikz)$/i.test(file.name); }
function toBase64(buffer: ArrayBuffer) { const bytes = new Uint8Array(buffer); let binary = ''; const chunk = 0x8000; for (let offset = 0; offset < bytes.length; offset += chunk) binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk)); return btoa(binary); }
