import { Check, KeyRound } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ApiClient } from '../lib/api';
import type { PosterOptions, Template } from '../types';
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
  onCreate: (name: string, template: string, poster?: PosterOptions) => Promise<void>;
  onPendingChange?: (pending: boolean) => void;
}) {
  const [name, setName] = useState('Untitled paper');
  const [template, setTemplate] = useState('article');
  const [poster, setPoster] = useState<PosterOptions>({ subtitle: '', authors: '', affiliation: '', size: 'A1', orientation: 'landscape', columns: 2 });
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
      if (template === 'academic-classic' || template === 'modern-ml' || template === 'visual-results') await onCreate(name, template, poster);
      else await onCreate(name, template);
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
      {(template === 'academic-classic' || template === 'modern-ml' || template === 'visual-results') && <fieldset className="poster-setup" disabled={busy}>
        <legend>Poster setup</legend>
        <label className="field"><span>Subtitle</span><input value={poster.subtitle} onChange={(event) => setPoster({ ...poster, subtitle: event.target.value })} maxLength={240}/></label>
        <label className="field"><span>Authors</span><input value={poster.authors} onChange={(event) => setPoster({ ...poster, authors: event.target.value })} maxLength={500} placeholder="Names as they should appear"/></label>
        <label className="field"><span>Affiliation</span><input value={poster.affiliation} onChange={(event) => setPoster({ ...poster, affiliation: event.target.value })} maxLength={500}/></label>
        <div className="poster-setup__row">
          <label className="field"><span>Print size</span><select value={poster.size} onChange={(event) => setPoster({ ...poster, size: event.target.value as PosterOptions['size'] })}><option>A1</option><option>A0</option><option value="custom">Custom</option></select></label>
          {poster.size !== 'custom' && <label className="field"><span>Orientation</span><select value={poster.orientation} onChange={(event) => setPoster({ ...poster, orientation: event.target.value as PosterOptions['orientation'] })}><option value="landscape">Landscape</option><option value="portrait">Portrait</option></select></label>}
          <label className="field"><span>Columns</span><select value={poster.columns} onChange={(event) => setPoster({ ...poster, columns: Number(event.target.value) as PosterOptions['columns'] })}><option value="2">2</option><option value="3">3</option><option value="4">4</option></select></label>
        </div>
        {poster.size === 'custom' && <div className="poster-setup__row">
          <label className="field"><span>Width (mm)</span><input type="number" min="200" max="3000" required value={poster.widthMm ?? ''} onChange={(event) => setPoster({ ...poster, widthMm: event.target.value ? Number(event.target.value) : undefined })}/></label>
          <label className="field"><span>Height (mm)</span><input type="number" min="200" max="3000" required value={poster.heightMm ?? ''} onChange={(event) => setPoster({ ...poster, heightMm: event.target.value ? Number(event.target.value) : undefined })}/></label>
        </div>}
      </fieldset>}
      <InlineError message={error}/>
      {busy && <p className="dialog-copy">You can close this dialog while the project is created.</p>}
      <div className="form-actions"><button type="button" className="plain-button" onClick={onClose}>{busy ? 'Close' : 'Cancel'}</button><button type="submit" className="primary-button" disabled={busy || !name.trim()} aria-busy={busy} aria-label={busy ? 'Creating project…' : undefined}>{busy ? <PendingLabel>Creating project…</PendingLabel> : 'Create project'}</button></div>
    </form>
  </Modal>;
}

export function AccountDialog({ open, onClose, api, username }: { open: boolean; onClose: () => void; api: ApiClient; username: string }) {
  return <Modal open={open} onClose={onClose} title={username} eyebrow="Account" size="small">
    <p className="dialog-copy">Your account and service access are managed centrally. Project sharing stays in Overroot.</p>
    <div className="form-actions"><button className="plain-button" type="button" onClick={onClose}>Close</button><a className="primary-button" href={api.url('/api/v1/auth/account')}><KeyRound size={14}/> Manage account</a></div>
  </Modal>;
}
