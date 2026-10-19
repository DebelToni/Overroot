import { ArrowRight, FileArchive, FileText, LogOut, Plus, Settings2, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Brand } from '../components/Brand';
import { AccountDialog, NewProjectDialog, InvitesDialog } from '../components/DashboardDialogs';
import { InlineError, LoadingBlock } from '../components/Feedback';
import { PendingLabel } from '../components/RootMark';
import { ThemeControl } from '../components/ThemeControl';
import { useTheme } from '../hooks/useTheme';
import { initials, relativeTime } from '../lib/format';
import { useSession } from '../lib/session';
import type { ProjectSummary, Template } from '../types';

export function DashboardPage() {
  const { api, user, clearSession } = useSession();
  const theme = useTheme();
  const navigate = useNavigate();
  const importInput = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const loadId = useRef(0);
  const newVisible = useRef(false);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [invitesOpen, setInvitesOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);

  async function load() {
    const requestGeneration = generation.current;
    const requestId = ++loadId.current;
    const isCurrent = () => requestGeneration === generation.current && requestId === loadId.current;
    setLoading(true); setError(null);
    try {
      const [projectResponse, templateResponse] = await Promise.all([api.listProjects(), api.listTemplates()]);
      if (isCurrent()) { setProjects(projectResponse.projects); setTemplates(templateResponse.templates); }
    } catch (reason) { if (isCurrent()) setError(reason instanceof Error ? reason.message : 'Could not load projects'); }
    finally { if (isCurrent()) setLoading(false); }
  }
  useEffect(() => {
    generation.current += 1;
    void load();
    return () => { generation.current += 1; };
  }, [api]);

  function showNewProject(open: boolean) {
    newVisible.current = open;
    if (open) setError(null);
    setNewOpen(open);
  }

  async function logout() {
    try { await api.logout(); } catch { /* Session is cleared locally either way. */ }
    clearSession();
  }

  async function create(name: string, template: string) {
    const requestGeneration = generation.current;
    try {
      const response = await api.createProject(name, template);
      if (requestGeneration !== generation.current) return;
      if (newVisible.current) navigate(`/project/${response.project.hash}`);
      else void load();
    } catch (reason) {
      if (requestGeneration === generation.current && !newVisible.current) setError(reason instanceof Error ? reason.message : 'Could not create project');
      throw reason;
    }
  }

  async function importZip(file: File) {
    if (importing) return;
    const requestGeneration = generation.current;
    setImporting(true); setError(null);
    try { const response = await api.importProject(file); if (requestGeneration === generation.current) navigate(`/project/${response.project.hash}`); }
    catch (reason) { if (requestGeneration === generation.current) setError(reason instanceof Error ? reason.message : 'Could not import ZIP'); }
    finally { if (requestGeneration === generation.current) setImporting(false); }
  }

  return <div className="dashboard-shell">
    <header className="dashboard-head">
      <Brand subtitle="Collaborative LaTeX studio"/>
      <div className="dashboard-head__actions">
        <ThemeControl value={theme.preference} onChange={theme.setPreference}/>
        {user?.isAdmin && <button className="plain-button admin-invites-button" type="button" aria-label="Invitations" title="Invitations" onClick={() => setInvitesOpen(true)}><Settings2 size={14}/><span>Invitations</span></button>}
        <button type="button" className="user-chip" aria-label={`Account settings for ${user?.displayName}`} onClick={() => setAccountOpen(true)}><span className="user-chip__details"><b>{user?.displayName}</b><small>{user?.isAdmin ? 'Admin' : 'Member'}</small></span><span className="user-chip__initials" aria-hidden="true">{initials(user?.displayName ?? '')}</span></button>
        <button className="icon-button" type="button" onClick={() => void logout()} aria-label="Log out" title="Log out"><LogOut size={16}/></button>
      </div>
    </header>
    <div className="accent-line"/>
    <main className="dashboard-main">
      <section className="dashboard-intro">
        <h1>Projects</h1>
        <div className="dashboard-intro__actions">
          <button className="secondary-button" type="button" onClick={() => importInput.current?.click()} disabled={importing} aria-busy={importing} aria-label={importing ? 'Importing ZIP…' : undefined}>{importing ? <PendingLabel>Importing ZIP…</PendingLabel> : <><Upload size={15}/>Import ZIP</>}</button>
          <input ref={importInput} hidden type="file" accept=".zip,application/zip" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importZip(file); event.target.value = ''; }}/>
          <button className="primary-button" type="button" onClick={() => showNewProject(true)} aria-busy={creating && !newOpen} aria-label={creating && !newOpen ? 'Creating project…' : undefined} title={creating && !newOpen ? 'View creation progress' : undefined}>{creating && !newOpen ? <PendingLabel>Creating project…</PendingLabel> : <><Plus size={15}/> New project</>}</button>
        </div>
      </section>
      <InlineError message={error}/>
      <section className="project-section" aria-labelledby="projects-title">
        <header><h2 id="projects-title">All projects</h2><span>{projects.length.toString().padStart(2, '0')}</span></header>
        {loading ? <LoadingBlock label="Loading projects"/> : <div className="project-list">
          {projects.length === 0 && <div className="dashboard-empty"><FileArchive size={28}/><h3>No projects yet.</h3><p>Begin with a clean template or import an existing ZIP archive.</p><button className="plain-button" type="button" onClick={() => showNewProject(true)}>{creating ? 'View project creation' : 'Create your first project'} <ArrowRight size={14}/></button></div>}
          {projects.map((project) => <button key={project.hash} type="button" className="project-row" onClick={() => navigate(`/project/${project.hash}`)}>
            <span className="project-row__number" aria-hidden="true"><FileText size={21}/></span>
            <span className="project-row__main"><strong>{project.name}</strong><small>{project.entryFile}</small></span>
            <span className="project-row__meta"><small>Owner</small><b>{project.owner}</b></span>
            <span className="project-row__meta"><small>Access</small><b className="project-access-tag">{project.role}</b></span>
            <span className="project-row__meta"><small>Updated</small><b>{relativeTime(project.updatedAt)}</b></span>
            <span className={`compile-chip compile-chip--${project.latestCompileStatus ?? 'none'}`}><i/>{project.latestCompileStatus ?? 'Not compiled'}</span>
            <ArrowRight className="project-row__arrow" size={17}/>
          </button>)}
        </div>}
      </section>
    </main>
    <footer className="dashboard-footer"><span>Overroot · Private open-source studio</span><a href="https://github.com/DebelToni/Overroot" target="_blank" rel="noreferrer">Source</a></footer>
    <NewProjectDialog open={newOpen} templates={templates} onClose={() => showNewProject(false)} onCreate={create} onPendingChange={setCreating}/>
    {user?.isAdmin && <InvitesDialog open={invitesOpen} onClose={() => setInvitesOpen(false)} api={api}/>}
    {user && <AccountDialog open={accountOpen} onClose={() => setAccountOpen(false)} api={api} username={user.username}/>} 
  </div>;
}
