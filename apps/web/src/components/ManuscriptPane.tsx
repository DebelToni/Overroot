import { autocompletion, closeBrackets } from '@codemirror/autocomplete';
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import { searchKeymap } from '@codemirror/search';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, highlightActiveLine, keymap, lineNumbers } from '@codemirror/view';
import { latex } from 'codemirror-lang-latex';
import { useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import type { ApiClient } from '../lib/api';
import { colorFor } from '../lib/format';
import { ManuscriptEditor } from '../lib/manuscript-editor';
import { TicketedYProvider, type ConnectionStatus } from '../lib/y-provider';
import type { ProjectFile, SourceLocation, User } from '../types';
import { editorTheme, type PresenceUser } from './EditorPane';

export function ManuscriptPane({ api, projectHash, entryFile, files, user, canWrite, dark, refreshKey, onPresence, onFlushReady, onCursorChange }: {
  api: ApiClient; projectHash: string; entryFile: string; files: ProjectFile[];
  user: User; canWrite: boolean; dark: boolean; refreshKey: number;
  onPresence: (users: PresenceUser[]) => void;
  onFlushReady: (flush: (() => Promise<void>) | null) => void;
  onCursorChange: (location: SourceLocation | null) => void;
}) {
  const mount = useRef<HTMLDivElement>(null);
  const editor = useRef<ManuscriptEditor | null>(null);
  const theme = useRef(new Compartment());
  const darkRef = useRef(dark);
  darkRef.current = dark;
  const [status, setStatus] = useState('Loading manuscript…');
  const [error, setError] = useState(false);
  const [notice, setNotice] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [retry, setRetry] = useState(0);
  // Content changes arrive through Yjs. Reconnect only for file topology or a
  // read-only refresh, not for every saved revision emitted by our own edits.
  const topology = JSON.stringify(files.filter((file) => file.kind === 'text').map(({ id, path }) => ({ id, path })));
  const readOnlyRefresh = canWrite ? 0 : refreshKey;

  useEffect(() => {
    let cancelled = false;
    const docs: Y.Doc[] = [];
    const providers = new Map<string, TicketedYProvider>();
    const states = new Map<string, ConnectionStatus>();
    const disposers: Array<() => void> = [];
    const readOnly = new Compartment();
    setStatus('Loading manuscript…'); setError(false); setNotice(''); setWarnings([]);
    onFlushReady(async () => { throw new Error('Wait for the manuscript to synchronize before compiling.'); });
    const metadata = JSON.parse(topology) as Array<{ id: string; path: string }>;
    const updatePresence = () => {
      const people = new Map<string, PresenceUser>();
      for (const provider of providers.values()) for (const [clientId, state] of provider.awareness.getStates()) {
        const person = state.user as { id?: string; name?: string; color?: string } | undefined;
        if (person?.name) people.set(person.id ?? String(clientId), { clientId, name: person.name, color: person.color ?? colorFor(String(clientId)) });
      }
      onPresence([...people.values()]);
    };
    const updateStatus = () => {
      const connected = states.size === metadata.length && [...states.values()].every((state) => state === 'connected');
      setStatus(canWrite ? connected ? 'connected' : 'Synchronizing…' : 'read only');
      editor.current?.view.dispatch({ effects: readOnly.reconfigure([EditorState.readOnly.of(!canWrite || !connected), EditorView.editable.of(canWrite && connected)]) });
    };
    void Promise.all(metadata.map(async (file) => {
      const response = await api.getFile(projectHash, file.id);
      return { ...file, content: response.file.content ?? '' };
    })).then((loaded) => {
      if (cancelled || !mount.current) return;
      const documents = loaded.map((file) => {
        const doc = new Y.Doc(); docs.push(doc);
        if (canWrite) {
          const provider = new TicketedYProvider(api, projectHash, file.id, doc);
          providers.set(file.id, provider);
          provider.awareness.setLocalStateField('user', { id: user.id, name: user.displayName, color: colorFor(user.id) });
          disposers.push(provider.subscribe((state) => { states.set(file.id, state); updateStatus(); }));
          provider.awareness.on('change', updatePresence);
        } else doc.getText('content').insert(0, file.content);
        return { id: file.id, path: file.path, doc };
      });
      editor.current = new ManuscriptEditor(mount.current, entryFile, documents, [
        lineNumbers(), highlightActiveLine(), EditorView.lineWrapping,
        EditorView.contentAttributes.of({ 'aria-label': 'Manuscript source', tabindex: '0' }),
        closeBrackets(), autocompletion(), latex(),
        keymap.of([...defaultKeymap, ...searchKeymap, indentWithTab]),
        theme.current.of(editorTheme(darkRef.current)),
        readOnly.of([EditorState.readOnly.of(true), EditorView.editable.of(false)])
      ], (id) => canWrite && states.get(id) === 'connected', onCursorChange, (message, issues) => { setNotice(message); setWarnings(issues); });
      onFlushReady(canWrite ? async () => { await Promise.all([...providers.values()].map((provider) => provider.flush())); } : null);
      updateStatus(); updatePresence();
    }).catch(() => {
      if (!cancelled) { setError(true); setStatus('Could not load the manuscript. Retry or open Files.'); onFlushReady(null); }
    });
    return () => {
      cancelled = true;
      disposers.forEach((dispose) => dispose());
      editor.current?.destroy(); editor.current = null;
      providers.forEach((provider) => provider.destroy());
      docs.forEach((doc) => doc.destroy());
      onFlushReady(null); onPresence([]); onCursorChange(null);
    };
  }, [api, projectHash, entryFile, topology, canWrite, readOnlyRefresh, retry, user.id, user.displayName, onPresence, onFlushReady, onCursorChange]);

  useEffect(() => {
    editor.current?.view.dispatch({ effects: theme.current.reconfigure(editorTheme(dark)) });
  }, [dark]);

  return <div className="manuscript-pane">
    <div className="pane-label"><span>Manuscript</span><span role="status">{status}</span></div>
    {error && <button type="button" className="plain-button" onClick={() => setRetry((value) => value + 1)}>Retry manuscript</button>}
    {(notice || warnings.length > 0) && <div className="manuscript-notice" role="status">{notice}{warnings.length > 0 && <details><summary>{warnings.length} input{warnings.length === 1 ? '' : 's'} could not be expanded</summary>{warnings.map((warning, index) => <p key={index}>{warning}</p>)}</details>}</div>}
    <div ref={mount} className="editor-mount" />
  </div>;
}
