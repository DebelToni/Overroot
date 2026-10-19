import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspacePage } from './WorkspacePage';

const harness = vi.hoisted(() => ({
  api: { getProject: vi.fn(), listFiles: vi.fn(), latestCompile: vi.fn(), getFile: vi.fn() },
  flush: vi.fn(async () => {}),
  user: { id: 'writer', username: 'writer', displayName: 'Writer', isAdmin: false, createdAt: '' }
}));
vi.mock('../lib/session', () => ({ useSession: () => ({ api: harness.api, user: harness.user, clearSession: vi.fn() }) }));
vi.mock('../hooks/useTheme', () => ({ useTheme: () => ({ preference: 'light', resolved: 'light', setPreference: vi.fn() }) }));
vi.mock('../hooks/useProjectEvents', () => ({ useProjectEvents: () => {} }));
vi.mock('../components/PdfViewer', () => ({ PdfViewer: () => <div>PDF test preview</div> }));
vi.mock('../components/WorkspaceDialogs', () => ({ AgentDialog: () => null, CompileLogDrawer: () => null, FileActionsDialog: () => null, HistoryDrawer: () => null, NewFileDialog: () => null, ProjectSettingsDialog: () => null, ShareDialog: () => null }));
vi.mock('../components/ManuscriptPane', async () => {
  const { useEffect } = await import('react');
  return { ManuscriptPane: function Pane({ onFlushReady }: { onFlushReady: (flush: (() => Promise<void>) | null) => void }) {
    useEffect(() => { onFlushReady(() => harness.flush()); return () => onFlushReady(null); }, [onFlushReady]);
    return <div>Manuscript test editor</div>;
  } };
});
vi.mock('../components/EditorPane', async () => {
  const { useEffect } = await import('react');
  return { EditorPane: function Pane({ onFlushReady }: { onFlushReady: (flush: (() => Promise<void>) | null) => void }) {
    useEffect(() => { onFlushReady(() => harness.flush()); return () => onFlushReady(null); }, [onFlushReady]);
    return <div>File test editor</div>;
  } };
});

const main = { id: 'main', path: 'main.tex', kind: 'text', content: 'Main' };
const result = { id: 'result', path: 'result.tex', kind: 'text', content: 'Result' };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
beforeEach(() => {
  vi.clearAllMocks();
  harness.flush.mockImplementation(async () => {});
  harness.api.getProject.mockResolvedValue({ project: { hash: 'project', name: 'Paper', entryFile: 'main.tex', role: 'owner', canWrite: true, canManage: true, memberCount: 1 } });
  harness.api.listFiles.mockResolvedValue({ files: [main, result] });
  harness.api.latestCompile.mockResolvedValue({ job: null });
  harness.api.getFile.mockImplementation(async (_hash: string, id: string) => ({ file: id === 'main' ? main : result }));
});
afterEach(cleanup);
async function openWorkspace() {
  render(<MemoryRouter initialEntries={['/project/project']}><Routes><Route path="/project/:hash" element={<WorkspacePage/>}/></Routes></MemoryRouter>);
  await screen.findByText('Manuscript test editor');
}

describe('source-view navigation races', () => {
  it('still opens a selected file when no newer choice supersedes it', async () => {
    await openWorkspace();
    fireEvent.click(screen.getByRole('button', { name: 'result.tex' }));
    await screen.findByText('File test editor');
    expect(screen.getByRole('button', { name: 'Files' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('ignores a delayed file selection after the user chooses Manuscript', async () => {
    const pending = deferred<{ file: typeof result }>();
    harness.api.getFile.mockImplementation((_hash: string, id: string) => id === 'result' ? pending.promise : Promise.resolve({ file: main }));
    await openWorkspace();
    fireEvent.click(screen.getByRole('button', { name: 'result.tex' }));
    await waitFor(() => expect(harness.api.getFile).toHaveBeenCalledWith('project', 'result'));
    fireEvent.click(screen.getByRole('button', { name: 'Manuscript' }));
    await act(async () => { pending.resolve({ file: result }); });
    expect(screen.getByRole('button', { name: 'Manuscript' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Manuscript test editor')).toBeInTheDocument();
  });

  it('cancels a pending Manuscript switch when the user chooses Files again', async () => {
    await openWorkspace();
    fireEvent.click(screen.getByRole('button', { name: 'Files' }));
    await screen.findByText('File test editor');
    const pending = deferred<void>();
    harness.flush.mockImplementation(() => pending.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Manuscript' }));
    fireEvent.click(screen.getByRole('button', { name: 'Files' }));
    await act(async () => { pending.resolve(); });
    expect(screen.getByRole('button', { name: 'Files' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('File test editor')).toBeInTheDocument();
  });

  it('ignores a stale file error after the user chooses Manuscript', async () => {
    const pending = deferred<{ file: typeof result }>();
    harness.api.getFile.mockImplementation((_hash: string, id: string) => id === 'result' ? pending.promise : Promise.resolve({ file: main }));
    await openWorkspace();
    fireEvent.click(screen.getByRole('button', { name: 'result.tex' }));
    await waitFor(() => expect(harness.api.getFile).toHaveBeenCalledWith('project', 'result'));
    fireEvent.click(screen.getByRole('button', { name: 'Manuscript' }));
    await act(async () => { pending.reject(new Error('late file failure')); });
    expect(screen.queryByText('late file failure')).not.toBeInTheDocument();
    expect(screen.getByText('Manuscript test editor')).toBeInTheDocument();
  });
});
