import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Y from 'yjs';
import type { ApiClient } from '../lib/api';
import type { ProjectFile } from '../types';
import { ManuscriptPane } from './ManuscriptPane';

const transport = vi.hoisted(() => ({ instances: new Map<string, { doc: Y.Doc; flush: ReturnType<typeof vi.fn>; destroyed: boolean }>(), content: new Map<string, string>() }));
vi.mock('../lib/y-provider', () => ({
  TicketedYProvider: class {
    destroyed = false;
    flush = vi.fn(async () => {});
    awareness = { setLocalStateField: vi.fn(), on: vi.fn(), getStates: () => new Map() };
    constructor(_api: unknown, _hash: string, id: string, readonly doc: Y.Doc) {
      doc.getText('content').insert(0, transport.content.get(id) ?? '');
      transport.instances.set(id, this);
    }
    subscribe(callback: (state: string) => void) { callback('connected'); return () => {}; }
    destroy() { this.destroyed = true; }
  }
}));
afterEach(() => { cleanup(); transport.instances.clear(); transport.content.clear(); });

function props(canWrite = true) {
  transport.content.set('main', 'Start\\input{body}End');
  transport.content.set('body', 'Body content');
  const files = [{ id: 'main', path: 'main.tex', kind: 'text' }, { id: 'body', path: 'body.tex', kind: 'text' }] as ProjectFile[];
  const getFile = vi.fn(async (_hash: string, id: string) => ({ file: { content: transport.content.get(id) } }));
  return { api: { getFile } as unknown as ApiClient, projectHash: 'project', entryFile: 'main.tex', files, user: { id: 'user', username: 'writer', displayName: 'Writer', isAdmin: false, createdAt: '' }, canWrite, dark: false, refreshKey: 0, onPresence: vi.fn(), onFlushReady: vi.fn(), onCursorChange: vi.fn() };
}

describe('Manuscript pane lifecycle', () => {
  it('connects the original modules, saves into the body, and flushes every file', async () => {
    const properties = props();
    const result = render(<ManuscriptPane {...properties}/>);
    await screen.findByText('connected');
    const view = EditorView.findFromDOM(result.container.querySelector('.cm-content')!)!;
    act(() => { view.dispatch({ changes: { from: view.state.doc.toString().indexOf('Body content'), insert: 'Human ' } }); });
    expect(transport.instances.get('body')!.doc.getText('content').toString()).toBe('Human Body content');
    expect(transport.instances.get('main')!.doc.getText('content').toString()).toBe('Start\\input{body}End');
    const flush = properties.onFlushReady.mock.lastCall![0] as () => Promise<void>;
    await flush();
    for (const provider of transport.instances.values()) expect(provider.flush).toHaveBeenCalledOnce();
    const body = transport.instances.get('body')!;
    act(() => { body.doc.transact(() => body.doc.getText('content').insert(0, 'Agent '), Symbol('agent')); });
    await waitFor(() => expect(view.state.doc.toString()).toContain('Agent Human Body content'));
    result.unmount();
    expect(body.destroyed).toBe(true);
    expect(properties.onFlushReady).toHaveBeenLastCalledWith(null);
  });

  it('propagates a flush failure so compilation cannot silently use stale modules', async () => {
    const properties = props(); render(<ManuscriptPane {...properties}/>);
    await screen.findByText('connected');
    transport.instances.get('body')!.flush.mockRejectedValueOnce(new Error('Disconnected'));
    await expect(properties.onFlushReady.mock.lastCall![0]()).rejects.toThrow('Disconnected');
  });

  it('loads a viewer without writable sockets and refreshes after an agent event', async () => {
    const properties = props(false);
    const result = render(<ManuscriptPane {...properties}/>);
    await screen.findByText('read only');
    expect(transport.instances.size).toBe(0);
    expect(result.container.querySelector('.cm-content')!.getAttribute('contenteditable')).toBe('false');
    transport.content.set('body', 'Updated by agent');
    result.rerender(<ManuscriptPane {...properties} refreshKey={1}/>);
    await waitFor(() => expect(result.container.textContent).toContain('Updated by agent'));
  });

  it('offers retry and allows leaving Files after a load error', async () => {
    const properties = props();
    vi.mocked(properties.api.getFile).mockRejectedValueOnce(new Error('network'));
    render(<ManuscriptPane {...properties}/>);
    await screen.findByRole('button', { name: 'Retry manuscript' });
    expect(properties.onFlushReady).toHaveBeenLastCalledWith(null);
  });
});
