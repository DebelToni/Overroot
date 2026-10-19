import { CalendarClock, Check, KeyRound, Link2, Plus, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ApiClient, CreatedInvite, InviteSummary } from '../lib/api';
import { relativeTime } from '../lib/format';
import type { Template } from '../types';
import { CopyButton } from './CopyButton';
import { InlineError, LoadingBlock } from './Feedback';
import { Modal } from './Modal';
import { PendingLabel } from './RootMark';

export function NewProjectDialog({
  open,
  templates,
  onClose,
  onCreate,
  onPendingChange
}: {
  open: boolean;
  templates: Template[];
  onClose: () => void;
  onCreate: (name: string, template: string) => Promise<void>;
  onPendingChange?: (pending: boolean) => void;
}) {
  const [name, setName] = useState('Untitled paper');
  const [template, setTemplate] = useState('article');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef(false);
  const visible = useRef(open);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    visible.current = open;
    // Reopening an in-flight operation must show the draft actually being created.
    if (open && !busy) { setName('Untitled paper'); setTemplate(templates[0]?.id ?? 'article'); setError(null); }
  }, [open]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(null); onPendingChange?.(true);
    try {
      await onCreate(name, template);
      if (active.current && visible.current) onClose();
    } catch (reason) {
      if (active.current) setError(reason instanceof Error ? reason.message : 'Could not create project');
    } finally {
      if (active.current) { setBusy(false); onPendingChange?.(false); }
    }
  }
  return <Modal open={open} onClose={onClose} title="Start a new project" eyebrow="New project" size="large">
    <form onSubmit={submit} className="stack-form">
      <label className="field"><span>Project name</span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} maxLength={100} required disabled={busy}/></label>
      <fieldset className="template-grid" disabled={busy}><legend>Choose a starting point</legend>
        {templates.map((item) => <label key={item.id} className={`template-card ${template === item.id ? 'is-selected' : ''}`}>
          <input type="radio" name="template" value={item.id} checked={template === item.id} onChange={() => setTemplate(item.id)}/>
          <span className="template-card__check">{template === item.id && <Check size={13}/>}</span>
          <strong>{item.name}</strong><small>{item.description}</small><code>{item.entryFile}</code>
        </label>)}
      </fieldset>
      <InlineError message={error}/>
      {busy && <p className="dialog-copy">You can close this dialog while the project is created.</p>}
      <div className="form-actions"><button type="button" className="plain-button" onClick={onClose}>{busy ? 'Close' : 'Cancel'}</button><button type="submit" className="primary-button" disabled={busy || !name.trim()} aria-busy={busy} aria-label={busy ? 'Creating project…' : undefined}>{busy ? <PendingLabel>Creating project…</PendingLabel> : 'Create project'}</button></div>
    </form>
  </Modal>;
}

export function InvitesDialog({ open, onClose, api }: { open: boolean; onClose: () => void; api: ApiClient }) {
  const [invites, setInvites] = useState<InviteSummary[]>([]);
  const [created, setCreated] = useState<CreatedInvite | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function load() {
    setLoading(true); setError(null);
    try { setInvites((await api.listInvites()).invites); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not load invitations'); } finally { setLoading(false); }
  }
  useEffect(() => { if (open) { setCreated(null); void load(); } }, [open]);
  async function create() {
    setError(null);
    try { const value = await api.createInvite(7); setCreated(value); await load(); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not create invitation'); }
  }
  async function remove(id: string) { await api.deleteInvite(id); await load(); }
  return <Modal open={open} onClose={onClose} title="Invite people" eyebrow="Administration" size="large">
    <div className="dialog-intro"><p>Invitations work once and expire after seven days. New members choose only a username and password.</p><button className="primary-button" type="button" onClick={create}><Plus size={14}/> New invitation</button></div>
    <InlineError message={error}/>
    {created && <section className="secret-card"><div className="secret-card__label"><Link2 size={14}/> Share this link once</div><code>{created.registrationUrl}</code><CopyButton value={created.registrationUrl}/><small>Expires {new Date(created.expiresAt).toLocaleString()}</small></section>}
    {loading ? <LoadingBlock/> : <div className="rule-list">
      {invites.length === 0 && <div className="empty-row">No invitations yet.</div>}
      {invites.map((invite) => <div className="rule-row" key={invite.id}>
        <CalendarClock size={15}/><div><strong>{invite.usedAt ? `Used by ${invite.usedBy}` : 'Unused invitation'}</strong><small>Created by {invite.createdBy} · expires {relativeTime(invite.expiresAt)}</small></div>
        <span className={`status-label ${invite.usedAt ? '' : 'status-label--active'}`}>{invite.usedAt ? 'USED' : 'OPEN'}</span>
        {!invite.usedAt && <button className="icon-button icon-button--danger" type="button" onClick={() => void remove(invite.id)} aria-label="Delete invitation"><Trash2 size={14}/></button>}
      </div>)}
    </div>}
  </Modal>;
}

export function AccountDialog({ open, onClose, api, username }: { open: boolean; onClose: () => void; api: ApiClient; username: string }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  useEffect(() => { if (open) { setCurrentPassword(''); setNewPassword(''); setConfirmPassword(''); setError(null); setSuccess(null); } }, [open]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (newPassword !== confirmPassword) { setError('The new passwords do not match'); return; }
    setBusy(true); setError(null); setSuccess(null);
    try { await api.changePassword(currentPassword, newPassword); setSuccess('Password updated.'); setCurrentPassword(''); setNewPassword(''); setConfirmPassword(''); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not update password'); }
    finally { setBusy(false); }
  }
  return <Modal open={open} onClose={onClose} title={username} eyebrow="Account" size="small"><form className="stack-form" onSubmit={submit}>
    <p className="dialog-copy">Your account is local to this Overroot server. No email or two-factor authentication is attached.</p>
    <label className="field"><span>Current password</span><input type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required/></label>
    <label className="field"><span>New password</span><input type="password" autoComplete="new-password" minLength={8} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required/></label>
    <label className="field"><span>Confirm new password</span><input type="password" autoComplete="new-password" minLength={8} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required/></label>
    <InlineError message={error}/>{success && <div className="inline-message inline-message--success"><Check size={14}/>{success}</div>}
    <div className="form-actions"><button className="plain-button" type="button" onClick={onClose}>Close</button><button className="primary-button" type="submit" disabled={busy}><KeyRound size={14}/>{busy ? 'Updating…' : 'Update password'}</button></div>
  </form></Modal>;
}
