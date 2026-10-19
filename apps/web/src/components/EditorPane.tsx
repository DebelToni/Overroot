import { autocompletion, closeBrackets } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { latex } from 'codemirror-lang-latex';
import { searchKeymap } from '@codemirror/search';
import { Compartment, EditorState } from '@codemirror/state';
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder
} from '@codemirror/view';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import { useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import type { ApiClient } from '../lib/api';
import { colorFor } from '../lib/format';
import { TicketedYProvider, type ConnectionStatus } from '../lib/y-provider';
import type { ProjectFile, SourceLocation, User } from '../types';

export interface PresenceUser {
  clientId: number;
  name: string;
  color: string;
}

export function EditorPane({
  api,
  projectHash,
  file,
  user,
  canWrite,
  dark,
  onPresence,
  onFlushReady,
  onCursorChange
}: {
  api: ApiClient;
  projectHash: string;
  file: ProjectFile | null;
  user: User;
  canWrite: boolean;
  dark: boolean;
  onPresence: (users: PresenceUser[]) => void;
  onFlushReady: (flush: (() => Promise<void>) | null) => void;
  onCursorChange: (location: SourceLocation | null) => void;
}) {
  const mount = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const themeCompartmentRef = useRef<Compartment | null>(null);
  const [connection, setConnection] = useState<ConnectionStatus>('disconnected');

  useEffect(() => {
    if (!mount.current || !file || file.kind !== 'text') {
      onPresence([]);
      onFlushReady(null);
      onCursorChange(null);
      return;
    }
    const themeCompartment = new Compartment();
    const readOnlyCompartment = new Compartment();
    themeCompartmentRef.current = themeCompartment;
    const doc = new Y.Doc();
    let provider: TicketedYProvider | null = null;
    let reportedLine = 0;
    const reportCursor = (view: EditorView) => {
      const line = view.state.doc.lineAt(view.state.selection.main.head).number;
      if (line === reportedLine) return;
      reportedLine = line;
      onCursorChange({ path: file.path, line });
    };
    const extensions = [
      lineNumbers(),
      highlightActiveLineGutter(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      EditorView.lineWrapping,
      highlightActiveLine(),
      closeBrackets(),
      autocompletion(),
      latex(),
      keymap.of([...defaultKeymap, ...editorHistoryKeymap(canWrite), ...searchKeymap, indentWithTab]),
      placeholder('Start writing LaTeX…'),
      EditorView.updateListener.of((update) => {
        if (update.selectionSet || update.docChanged) reportCursor(update.view);
      }),
      themeCompartment.of(editorTheme(dark)),
      readOnlyCompartment.of(EditorState.readOnly.of(true))
    ];

    let initialDoc = file.content ?? '';
    if (canWrite) {
      initialDoc = '';
      provider = new TicketedYProvider(api, projectHash, file.id, doc);
      provider.awareness.setLocalStateField('user', {
        id: user.id,
        name: user.displayName,
        color: colorFor(user.id),
        colorLight: `${colorFor(user.id)}33`
      });
      const undoManager = new Y.UndoManager(doc.getText('content'));
      extensions.push(yCollab(doc.getText('content'), provider.awareness, { undoManager }));
      const updatePresence = () => {
        const users: PresenceUser[] = [];
        for (const [clientId, state] of provider!.awareness.getStates()) {
          const person = state.user as { name?: string; color?: string } | undefined;
          if (person?.name) users.push({ clientId, name: person.name, color: person.color ?? colorFor(String(clientId)) });
        }
        onPresence(users);
      };
      provider.awareness.on('change', updatePresence);
      updatePresence();
    } else {
      extensions.push(history());
      onPresence([]);
    }

    const view = new EditorView({
      state: EditorState.create({ doc: initialDoc, extensions }),
      parent: mount.current
    });
    viewRef.current = view;
    reportCursor(view);
    const unsubscribe = provider?.subscribe((status) => {
      setConnection(status);
      view.dispatch({ effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(!canWrite || status !== 'connected')) });
    });
    onFlushReady(provider ? () => provider!.flush() : null);

    return () => {
      unsubscribe?.();
      onFlushReady(null);
      provider?.destroy();
      view.destroy();
      viewRef.current = null;
      themeCompartmentRef.current = null;
      doc.destroy();
      onPresence([]);
      onCursorChange(null);
    };
  }, [api, projectHash, file?.id, file?.content, file?.path, canWrite, user.id, user.displayName, onPresence, onFlushReady, onCursorChange]);

  useEffect(() => {
    const view = viewRef.current;
    const compartment = themeCompartmentRef.current;
    if (view && compartment) view.dispatch({ effects: compartment.reconfigure(editorTheme(dark)) });
  }, [dark]);

  if (!file) return <div className="editor-empty"><span>Select a file to begin.</span></div>;
  if (file.kind !== 'text') {
    return <div className="editor-empty"><span>{file.path} is a binary file. It is available to the compiler but cannot be edited here.</span></div>;
  }

  return (
    <div className="editor-pane">
      <div className="pane-label">
        <span>{file.path}</span>
        <span className={`connection connection--${connection}`}>{canWrite ? connection : 'read only'}</span>
      </div>
      <div ref={mount} className="editor-mount" />
    </div>
  );
}

export function editorHistoryKeymap(collaborative: boolean) {
  return collaborative ? yUndoManagerKeymap : historyKeymap;
}

export function editorTheme(dark: boolean) {
  return EditorView.theme(
    {
      '&': {
        height: '100%',
        color: 'var(--ink-2)',
        backgroundColor: 'var(--paper)',
        fontSize: '14px'
      },
      '.cm-scroller': {
        fontFamily: 'var(--mono)',
        lineHeight: '1.65',
        overflow: 'auto'
      },
      '.cm-content': { padding: '22px 0 80px', caretColor: 'var(--accent)' },
      '.cm-line': { padding: '0 24px 0 12px' },
      '.cm-gutters': {
        backgroundColor: 'var(--paper)',
        color: 'var(--faint)',
        border: '0',
        paddingTop: '22px'
      },
      '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--surface)' },
      '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: 'color-mix(in srgb, var(--accent) 22%, transparent) !important' },
      '&.cm-focused': { outline: 'none' },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
      '.cm-tooltip': {
        backgroundColor: 'var(--paper)',
        border: '1px solid var(--line)',
        borderRadius: '7px'
      }
    },
    { dark }
  );
}
