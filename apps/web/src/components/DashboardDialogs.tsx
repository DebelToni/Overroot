import { Check, KeyRound } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ApiClient } from '../lib/api';
import type { Template } from '../types';
import { InlineError } from './Feedback';
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

export function AccountDialog({ open, onClose, api, username }: { open: boolean; onClose: () => void; api: ApiClient; username: string }) {
  return <Modal open={open} onClose={onClose} title={username} eyebrow="Account" size="small">
    <p className="dialog-copy">Your account and password are shared with Space. Project access is managed in Overroot.</p>
    <div className="form-actions"><button className="plain-button" type="button" onClick={onClose}>Close</button><a className="primary-button" href={api.url('/api/v1/auth/account')}><KeyRound size={14}/> Manage account</a></div>
  </Modal>;
}
