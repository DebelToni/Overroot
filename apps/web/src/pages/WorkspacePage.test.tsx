import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspacePage } from './WorkspacePage';

const harness = vi.hoisted(() => ({
  api: { getProject: vi.fn(), listFiles: vi.fn(), latestCompile: vi.fn(), getFile: vi.fn(), createFile: vi.fn(), renameFile: vi.fn(), compile: vi.fn() },
  flush: vi.fn(async () => {}),
  user: { id: 'writer', username: 'writer', displayName: 'Writer', isAdmin: false, createdAt: '' },
  onPresence: null as ((users: { clientId: number; name: string; color: string }[]) => void) | null,
  onEvent: null as ((event: { type: string; fileId: string }) => void) | null
}));
vi.mock('../lib/session', () => ({ useSession: () => ({ api: harness.api, user: harness.user, clearSession: vi.fn() }) }));
vi.mock('../hooks/useTheme', () => ({ useTheme: () => ({ preference: 'light', resolved: 'light', setPreference: vi.fn() }) }));
vi.mock('../hooks/useProjectEvents', () => ({ useProjectEvents: (_api: unknown, _hash: string, handler: typeof harness.onEvent) => { harness.onEvent = handler; } }));
vi.mock('../components/PdfViewer', () => ({ PdfViewer: () => <div>PDF test preview</div> }));
vi.mock('../components/Modal', () => ({ Modal: ({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: import('react').ReactNode }) => open ? <div role="dialog" aria-label={title}><button onClick={onClose}>Close dialog</button>{children}</div> : null }));
vi.mock('../components/WorkspaceDialogs', async (importOriginal) => {
  const { NewFileDialog, FileActionsDialog } = await importOriginal<typeof import('../components/WorkspaceDialogs')>();
  return { AgentDialog: () => null, CompileLogDrawer: () => null, FileActionsDialog, HistoryDrawer: () => null, NewFileDialog, ProjectSettingsDialog: () => null, ShareDialog: () => null };
});
vi.mock('../components/ManuscriptPane', async () => {
  const { useEffect } = await import('react');
  return { ManuscriptPane: function Pane({ onFlushReady, onPresence, entryFile }: { onFlushReady: (flush: (() => Promise<void>) | null) => void; onPresence: NonNullable<typeof harness.onPresence>; entryFile: string }) {
    useEffect(() => { harness.onPresence = onPresence; }, [onPresence]);
    useEffect(() => { onFlushReady(() => harness.flush()); return () => onFlushReady(null); }, [onFlushReady]);
    return <div>Manuscript test editor<span data-testid="manuscript-entry">{entryFile}</span></div>;
  } };
});
vi.mock('../components/EditorPane', async () => {
  const { useEffect } = await import('react');
  return { EditorPane: function Pane({ onFlushReady, file }: { onFlushReady: (flush: (() => Promise<void>) | null) => void; file: { content?: string } | null }) {
    useEffect(() => { onFlushReady(() => harness.flush()); return () => onFlushReady(null); }, [onFlushReady]);
    return <div>File test editor<span>{file?.content}</span></div>;
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
  vi.resetAllMocks();
  window.localStorage.clear();
  harness.flush.mockImplementation(async () => {});
  harness.api.getProject.mockResolvedValue({ project: { hash: 'project', name: 'Paper', entryFile: 'main.tex', role: 'owner', canWrite: true, canManage: true, memberCount: 1 } });
  harness.api.listFiles.mockResolvedValue({ files: [main, result] });
  harness.api.latestCompile.mockResolvedValue({ job: null });
  harness.api.getFile.mockImplementation(async (_hash: string, id: string) => ({ file: id === 'main' ? main : result }));
});
afterEach(cleanup);
async function openWorkspace() {
  render(<MemoryRouter initialEntries={['/project/project']}><Routes><Route path="/project/:hash" element={<WorkspacePage/>}/></Routes></MemoryRouter>);
  await screen.findByText(/(?:Manuscript|File) test editor/);
}
function startFileMutation(operation: string, path: string, content: string, renamePath?: string) {
  if (operation === 'create') {
    fireEvent.click(screen.getByRole('button', { name: 'Create file' }));
    const input = screen.getByLabelText('Path');
    fireEvent.change(input, { target: { value: path } });
    fireEvent.submit(input.closest('form')!);
  } else if (operation === 'rename') {
    fireEvent.click(screen.getByRole('button', { name: `Actions for ${renamePath}` }));
    fireEvent.change(screen.getByLabelText('Path'), { target: { value: path } });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
  } else {
    const source = new File([content], path, { type: 'text/plain' });
    Object.defineProperty(source, 'text', { value: async () => content });
    const upload = screen.getByRole('button', { name: 'Upload files' }).parentElement!.querySelector('input[type="file"]')!;
    fireEvent.change(upload, { target: { files: [source] } });
  }
}

describe('source view persistence', () => {
  it.each(['files', 'manuscript'])('restores the last opened file and %s mode after a remount', async (mode) => {
    await openWorkspace();
    fireEvent.click(screen.getByRole('button', { name: 'result.tex' }));
    await screen.findByText(result.content);
    if (mode === 'manuscript') {
      fireEvent.click(screen.getByRole('button', { name: 'Manuscript' }));
      await screen.findByText('Manuscript test editor');
    }
    cleanup();
    harness.api.getFile.mockClear();
    await openWorkspace();
    expect(harness.api.getFile).toHaveBeenCalledWith('project', result.id);
    expect(screen.getByRole('button', { name: result.path }).closest('.tree-file')).toHaveClass('is-active');
    expect(screen.getByRole('button', { name: mode === 'files' ? 'Files' : 'Manuscript' })).toHaveAttribute('aria-pressed', 'true');
    if (mode === 'files') expect(screen.getByText(result.content)).toBeInTheDocument();
    else expect(screen.getByTestId('manuscript-entry')).toHaveTextContent(result.path);
  });

  it('restores a renamed file by its stable ID', async () => {
    await openWorkspace();
    fireEvent.click(screen.getByRole('button', { name: result.path }));
    await screen.findByText(result.content);
    cleanup();
    const renamed = { ...result, path: 'renamed.tex' };
    harness.api.listFiles.mockResolvedValue({ files: [main, renamed] });
    harness.api.getFile.mockResolvedValue({ file: renamed });
    await openWorkspace();
    expect(screen.getByRole('button', { name: renamed.path }).closest('.tree-file')).toHaveClass('is-active');
  });

  it('falls back to the project default if the remembered file was deleted', async () => {
    await openWorkspace();
    fireEvent.click(screen.getByRole('button', { name: result.path }));
    await screen.findByText(result.content);
    cleanup();
    harness.api.listFiles.mockResolvedValue({ files: [main] });
    await openWorkspace();
    expect(screen.getByText(main.content)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: main.path }).closest('.tree-file')).toHaveClass('is-active');
    cleanup();
    harness.api.listFiles.mockResolvedValue({ files: [main, result] });
    await openWorkspace();
    expect(screen.getByText(main.content)).toBeInTheDocument();
  });

  it('keeps the last opened file when a newer selection fails', async () => {
    await openWorkspace();
    fireEvent.click(screen.getByRole('button', { name: result.path }));
    await screen.findByText(result.content);
    harness.api.getFile.mockRejectedValueOnce(new Error('Could not open file'));
    fireEvent.click(screen.getByRole('button', { name: main.path }));
    await screen.findByText('Could not open file');
    cleanup();
    await openWorkspace();
    expect(screen.getByText(result.content)).toBeInTheDocument();
  });
});

describe('online collaborators', () => {
  const people = ['Alice Smith', 'Alice Stone', 'Bo', 'Charlie', 'Dana', 'Eli'].map((name, clientId) => ({ clientId, name, color: '#2583e9' }));

  it('opens every full name on click, including matching initials and overflow avatars', async () => {
    await openWorkspace();
    act(() => harness.onPresence!(people));
    const trigger = screen.getByRole('button', { name: "Who's online (6)" });
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
    expect(trigger).toHaveTextContent('+2');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(trigger);
    const list = screen.getByRole('list', { name: 'Online collaborators' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(6);
    for (const person of people) expect(within(list).getByText(person.name)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('updates the open list as collaborators join and leave', async () => {
    await openWorkspace();
    act(() => harness.onPresence!(people.slice(0, 1)));
    fireEvent.click(screen.getByRole('button', { name: "Who's online (1)" }));
    act(() => harness.onPresence!(people.slice(1, 3)));
    const list = screen.getByRole('list', { name: 'Online collaborators' });
    expect(within(list).queryByText('Alice Smith')).not.toBeInTheDocument();
    expect(within(list).getByText('Alice Stone')).toBeInTheDocument();
    expect(within(list).getByText('Bo')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: "Who's online (2)" })).toBeInTheDocument();
    act(() => harness.onPresence!([]));
    expect(screen.getByText('No active collaborators.')).toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  it('can open the empty list before presence arrives', async () => {
    await openWorkspace();
    fireEvent.click(screen.getByRole('button', { name: "Who's online (0)" }));
    expect(screen.getByRole('dialog', { name: "Who's online" })).toHaveTextContent('No active collaborators.');
  });
});

it('compiles the open file rather than the stored project default', async () => {
  harness.api.compile.mockResolvedValue({ job: { id: 'job', status: 'queued', createdAt: new Date().toISOString() } });
  await openWorkspace();
  expect(screen.queryByText('MAIN')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'result.tex' }));
  await screen.findByText('File test editor');
  fireEvent.click(screen.getByRole('button', { name: 'Compile' }));
  await waitFor(() => expect(harness.api.compile).toHaveBeenCalledWith('project', 'result.tex'));
  expect(harness.flush).toHaveBeenCalled();
});

it('shows opening progress only while the project request is pending', async () => {
  const project = deferred<Awaited<ReturnType<typeof harness.api.getProject>>>();
  harness.api.getProject.mockReturnValueOnce(project.promise);
  render(<MemoryRouter initialEntries={['/project/project']}><Routes><Route path="/project/:hash" element={<WorkspacePage/>}/></Routes></MemoryRouter>);
  const status = screen.getByRole('status');
  expect(status).toHaveTextContent('Opening project');
  expect(status.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  await act(async () => { project.resolve({ project: { hash: 'project', name: 'Paper', entryFile: 'main.tex', role: 'owner', canWrite: true, canManage: true, memberCount: 1 } }); });
  await screen.findByText('Manuscript test editor');
  expect(screen.queryByText('Opening project')).not.toBeInTheDocument();
});

describe('source-view navigation races', () => {
  it.each(['create', 'upload', 'rename'])('still reports a pending %s failure after a newer tree selection', async (operation) => {
    await openWorkspace();
    fireEvent.click(screen.getByRole('button', { name: 'Files' }));
    await screen.findByText('File test editor');
    const mutation = deferred<{ file: typeof result }>();
    harness.api.createFile.mockReturnValue(mutation.promise);
    harness.api.renameFile.mockReturnValue(mutation.promise);
    startFileMutation(operation, 'created.tex', 'Created content', main.path);
    await waitFor(() => expect(operation === 'rename' ? harness.api.renameFile : harness.api.createFile).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'result.tex' }));
    await screen.findByText(result.content);
    await act(async () => { mutation.reject(new Error('mutation failed')); });
    expect(screen.getByText(/mutation failed/)).toBeInTheDocument();
    expect(screen.getByText(result.content)).toBeInTheDocument();
  });

  it.each(['create', 'upload', 'rename'])('preserves a newer tree selection while %s is still pending', async (operation) => {
    await openWorkspace();
    fireEvent.click(screen.getByRole('button', { name: 'Files' }));
    await screen.findByText('File test editor');
    const created = { ...(operation === 'rename' ? main : result), id: operation === 'rename' ? main.id : 'created', path: 'created.tex', content: 'Newly created content' };
    harness.api.getFile.mockImplementation(async (_hash: string, id: string) => ({ file: id === created.id ? created : id === main.id ? main : result }));
    const mutation = deferred<{ file: typeof created }>();
    harness.api.createFile.mockReturnValue(mutation.promise);
    harness.api.renameFile.mockReturnValue(mutation.promise);
    harness.api.listFiles.mockResolvedValue({ files: operation === 'rename' ? [created, result] : [main, result, created] });
    startFileMutation(operation, created.path, created.content, main.path);
    await waitFor(() => expect(operation === 'rename' ? harness.api.renameFile : harness.api.createFile).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'result.tex' }));
    await screen.findByText(result.content);
    await act(async () => { mutation.resolve({ file: created }); });
    expect(screen.getByText(result.content)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: result.path }).closest('.tree-file')).toHaveClass('is-active');
    expect(harness.api.getFile).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['create', 'older selection first'], ['create', 'new file first'],
    ['upload', 'older selection first'], ['upload', 'new file first'],
    ['rename', 'older selection first'], ['rename', 'new file first']
  ])('keeps the preferred file after %s with %s', async (operation, completionOrder) => {
    const created = { ...result, id: 'created', path: 'created.tex', content: 'Newly created content' };
    if (operation === 'rename') harness.api.listFiles.mockResolvedValue({ files: [main, result, { ...created, path: 'before.tex' }] });
    await openWorkspace();
    fireEvent.click(screen.getByRole('button', { name: 'Files' }));
    await screen.findByText('File test editor');
    const olderSelection = deferred<{ file: typeof result }>();
    const preferredSelection = deferred<{ file: typeof created }>();
    harness.api.getFile.mockImplementation((_hash: string, id: string) => id === result.id ? olderSelection.promise : id === created.id ? preferredSelection.promise : Promise.resolve({ file: main }));
    harness.api.createFile.mockResolvedValue({ file: created });
    harness.api.renameFile.mockResolvedValue({ file: created });
    harness.api.listFiles.mockResolvedValue({ files: [main, result, created] });
    fireEvent.click(screen.getByRole('button', { name: 'result.tex' }));
    await waitFor(() => expect(harness.api.getFile).toHaveBeenCalledWith('project', result.id));
    startFileMutation(operation, created.path, created.content, 'before.tex');
    await waitFor(() => expect(harness.api.getFile).toHaveBeenCalledWith('project', created.id));
    const finishOlder = async () => { await act(async () => { olderSelection.resolve({ file: result }); }); };
    const finishPreferred = async () => { await act(async () => { preferredSelection.resolve({ file: created }); }); };
    if (completionOrder === 'older selection first') {
      await finishOlder();
      await finishPreferred();
    } else {
      await finishPreferred();
      await finishOlder();
    }
    expect(screen.getByText(created.content)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: created.path }).closest('.tree-file')).toHaveClass('is-active');
  });

  it.each([
    ['manuscript', 'navigation first'], ['manuscript', 'refresh first'],
    ['files', 'navigation first'], ['files', 'refresh first']
  ])('preserves the latest read-only content when selecting the current file from %s with %s', async (mode, completionOrder) => {
    harness.api.getProject.mockResolvedValue({ project: { hash: 'project', name: 'Paper', entryFile: 'main.tex', role: 'viewer', canWrite: false, canManage: false, memberCount: 1 } });
    await openWorkspace();
    if (mode === 'files') {
      fireEvent.click(screen.getByRole('button', { name: 'Files' }));
      await screen.findByText('File test editor');
    }
    const navigation = deferred<{ file: typeof main }>();
    const refresh = deferred<{ file: typeof main }>();
    harness.api.getFile.mockReturnValueOnce(navigation.promise).mockReturnValueOnce(refresh.promise);
    fireEvent.click(screen.getByRole('button', { name: /^main\.tex/ }));
    await waitFor(() => expect(harness.api.getFile).toHaveBeenCalledTimes(2));
    act(() => { harness.onEvent!({ type: 'file.changed', fileId: main.id }); });
    expect(harness.api.getFile).toHaveBeenCalledTimes(3);
    const finishNavigation = async () => { await act(async () => { navigation.resolve({ file: main }); }); };
    const finishRefresh = async () => { await act(async () => { refresh.resolve({ file: { ...main, content: 'Newest collaborator text' } }); }); };
    if (completionOrder === 'navigation first') {
      await finishNavigation();
      await finishRefresh();
    } else {
      await finishRefresh();
      await finishNavigation();
    }
    expect(screen.getByRole('button', { name: 'Files' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Newest collaborator text')).toBeInTheDocument();
  });

  it.each(['file.changed', 'agent.changed'])('preserves a read-only %s refresh when the already-selected Files button is clicked', async (type) => {
    harness.api.getProject.mockResolvedValue({ project: { hash: 'project', name: 'Paper', entryFile: 'main.tex', role: 'viewer', canWrite: false, canManage: false, memberCount: 1 } });
    await openWorkspace();
    fireEvent.click(screen.getByRole('button', { name: 'Files' }));
    await screen.findByText('File test editor');
    const pending = deferred<{ file: typeof main }>();
    harness.api.getFile.mockReturnValueOnce(pending.promise);
    act(() => { harness.onEvent!({ type, fileId: main.id }); });
    expect(harness.api.getFile).toHaveBeenLastCalledWith('project', 'main');
    fireEvent.click(screen.getByRole('button', { name: 'Files' }));
    await act(async () => { pending.resolve({ file: { ...main, content: 'Updated collaborator text' } }); });
    expect(screen.getByText('Updated collaborator text')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Files' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('does not cancel a pending file selection when the current read-only file refreshes', async () => {
    harness.api.getProject.mockResolvedValue({ project: { hash: 'project', name: 'Paper', entryFile: 'main.tex', role: 'viewer', canWrite: false, canManage: false, memberCount: 1 } });
    await openWorkspace();
    fireEvent.click(screen.getByRole('button', { name: 'Files' }));
    await screen.findByText('File test editor');
    const pending = deferred<{ file: typeof result }>();
    harness.api.getFile.mockImplementation((_hash: string, id: string) => id === 'result' ? pending.promise : Promise.resolve({ file: { ...main, content: 'Current main refreshed' } }));
    fireEvent.click(screen.getByRole('button', { name: 'result.tex' }));
    await waitFor(() => expect(harness.api.getFile).toHaveBeenLastCalledWith('project', 'result'));
    act(() => { harness.onEvent!({ type: 'file.changed', fileId: main.id }); });
    await screen.findByText('Current main refreshed');
    await act(async () => { pending.resolve({ file: result }); });
    expect(screen.getByText('Result')).toBeInTheDocument();
  });

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
