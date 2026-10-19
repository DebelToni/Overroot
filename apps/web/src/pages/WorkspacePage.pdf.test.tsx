import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WorkspacePage } from './WorkspacePage';
import type { CompileJob, ProjectEvent } from '../types';

const harness = vi.hoisted(() => ({
  api: { getProject: vi.fn(), listFiles: vi.fn(), latestCompile: vi.fn(), getFile: vi.fn(), compilePdf: vi.fn(), compile: vi.fn() },
  flush: vi.fn(),
  onEvent: null as ((event: Pick<ProjectEvent, 'type' | 'job'>) => void) | null
}));
vi.mock('../lib/session', () => ({ useSession: () => ({ api: harness.api, user: { displayName: 'Writer' }, clearSession: vi.fn() }) }));
vi.mock('../hooks/useTheme', () => ({ useTheme: () => ({ preference: 'light', resolved: 'light', setPreference: vi.fn() }) }));
vi.mock('../hooks/useProjectEvents', () => ({ useProjectEvents: (_api: unknown, _hash: string, handler: typeof harness.onEvent) => { harness.onEvent = handler; } }));
vi.mock('../components/PdfViewer', () => ({ PdfViewer: ({ data, revision, synctexJobId }: { data: ArrayBuffer | null; revision: string; synctexJobId: string }) => <div>{data ? `PDF ${revision} SyncTeX ${synctexJobId}` : 'No PDF loaded'}</div> }));
vi.mock('../components/ManuscriptPane', async () => {
  const { useEffect } = await import('react');
  return { ManuscriptPane: function Pane({ onFlushReady }: { onFlushReady: (flush: (() => Promise<void>) | null) => void }) {
    useEffect(() => { onFlushReady(() => harness.flush()); return () => onFlushReady(null); }, [onFlushReady]);
    return <div>Test manuscript</div>;
  } };
});
vi.mock('../components/EditorPane', () => ({ EditorPane: () => null }));
vi.mock('../components/WorkspaceDialogs', () => ({ AgentDialog: () => null, CompileLogDrawer: () => null, FileActionsDialog: () => null, HistoryDrawer: () => null, NewFileDialog: () => null, ProjectSettingsDialog: () => null, ShareDialog: () => null }));

const successful: CompileJob = { id: 'good-job', status: 'succeeded', sourceHash: 'good-revision', hasPdf: true, hasSynctex: true, createdAt: '2026-10-19T10:00:00.000Z', startedAt: '2026-10-19T10:00:00.000Z', finishedAt: '2026-10-19T10:00:01.000Z', entryFile: 'main.tex', log: '', error: null, requestedBy: { type: 'user', id: 'writer', name: 'Writer' } };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
beforeEach(() => {
  vi.resetAllMocks();
  harness.flush.mockResolvedValue(undefined);
  harness.api.getProject.mockResolvedValue({ project: { hash: 'project', name: 'Paper', entryFile: 'main.tex', role: 'owner', canWrite: true, canManage: true, memberCount: 1 } });
  harness.api.listFiles.mockResolvedValue({ files: [] });
  harness.api.compilePdf.mockResolvedValue({ data: new ArrayBuffer(1) });
  harness.api.latestCompile.mockResolvedValue({ job: null, lastSuccessfulJob: null });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function openWorkspace() {
  render(<MemoryRouter initialEntries={['/project/project']}><Routes><Route path="/project/:hash" element={<WorkspacePage/>}/></Routes></MemoryRouter>);
}

it.each(['failed', 'cancelled', 'queued', 'compiling'])('restores the last good PDF and its SyncTeX while keeping the latest %s status', async (status) => {
  harness.api.latestCompile.mockResolvedValue({ job: { ...successful, id: 'new-job', status, hasPdf: false, hasSynctex: false }, lastSuccessfulJob: successful });
  openWorkspace();
  await screen.findByText('PDF good-revision SyncTeX good-job');
  expect(harness.api.compilePdf).toHaveBeenCalledWith('project', 'good-job');
  expect(screen.getByRole('button', { name: new RegExp(`^${status}`) })).toBeInTheDocument();
});

it('opens projects without any successful compile without fetching a PDF', async () => {
  harness.api.latestCompile.mockResolvedValue({ job: null, lastSuccessfulJob: null });
  openWorkspace();
  await screen.findByText('Test manuscript');
  expect(harness.api.compilePdf).not.toHaveBeenCalled();
});

it('shares one PDF download when readiness arrives before the compile response', async () => {
  openWorkspace();
  await screen.findByText('Test manuscript');
  const response = deferred<{ job: CompileJob }>();
  const download = deferred<{ data: ArrayBuffer }>();
  harness.api.compile.mockReturnValue(response.promise);
  harness.api.compilePdf.mockReturnValue(download.promise);
  fireEvent.click(screen.getByRole('button', { name: /^Compile$/ }));
  await waitFor(() => expect(harness.api.compile).toHaveBeenCalledTimes(1));
  act(() => harness.onEvent!({ type: 'compile.ready', job: successful }));
  await act(async () => { response.resolve({ job: successful }); });
  expect(harness.api.compilePdf).toHaveBeenCalledTimes(1);
  await act(async () => { download.resolve({ data: new ArrayBuffer(1) }); });
  await screen.findByText('PDF good-revision SyncTeX good-job');
});

it('reuses displayed bytes for an unchanged compile and updates its SyncTeX job', async () => {
  harness.api.latestCompile.mockResolvedValue({ job: successful });
  openWorkspace();
  await screen.findByText('PDF good-revision SyncTeX good-job');
  const cached = { ...successful, id: 'cached-job', createdAt: '2026-10-19T10:00:02.000Z' };
  harness.api.compile.mockResolvedValue({ job: cached });
  fireEvent.click(screen.getByRole('button', { name: /^Compile$/ }));
  await screen.findByText('PDF good-revision SyncTeX cached-job');
  expect(harness.api.compilePdf).toHaveBeenCalledTimes(1);
});

it('keeps a completed compile when its queued POST response arrives late', async () => {
  openWorkspace();
  await screen.findByText('Test manuscript');
  const response = deferred<{ job: CompileJob }>();
  harness.api.compile.mockReturnValue(response.promise);
  fireEvent.click(screen.getByRole('button', { name: /^Compile$/ }));
  await waitFor(() => expect(harness.api.compile).toHaveBeenCalledTimes(1));
  await act(async () => { harness.onEvent!({ type: 'compile.ready', job: successful }); });
  await screen.findByText('PDF good-revision SyncTeX good-job');
  await act(async () => { response.resolve({ job: { ...successful, status: 'queued', hasPdf: false, hasSynctex: false, finishedAt: null } }); });
  expect(screen.getByRole('button', { name: /^succeeded/ })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^Compile$/ })).toBeEnabled();
});

it('disables compilation while source synchronization and submission are pending', async () => {
  openWorkspace();
  await screen.findByText('Test manuscript');
  await act(async () => {});
  const flush = deferred<void>();
  const response = deferred<{ job: CompileJob }>();
  harness.flush.mockReturnValue(flush.promise);
  harness.api.compile.mockReturnValue(response.promise);
  const button = screen.getByRole('button', { name: /^Compile$/ });
  fireEvent.click(button);
  expect(button).toBeDisabled();
  fireEvent.click(button);
  expect(harness.flush).toHaveBeenCalledTimes(1);
  expect(harness.api.compile).not.toHaveBeenCalled();
  await act(async () => { flush.resolve(); });
  expect(button).toBeDisabled();
  await act(async () => { response.resolve({ job: successful }); });
  expect(button).toBeEnabled();
  expect(harness.api.compile).toHaveBeenCalledTimes(1);
});

it('re-enables compilation after source synchronization fails without submitting stale source', async () => {
  openWorkspace();
  await screen.findByText('Test manuscript');
  harness.flush.mockRejectedValueOnce(new Error('Source is still synchronizing'));
  fireEvent.click(screen.getByRole('button', { name: /^Compile$/ }));
  await screen.findByText('Source is still synchronizing');
  expect(harness.api.compile).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: /^Compile$/ })).toBeEnabled();
});

it('ignores a pending poll snapshot after a newer readiness event', async () => {
  const interval = vi.spyOn(window, 'setInterval');
  const pollTick = () => (interval.mock.calls.find(([, delay]) => delay === 1400)![0] as () => void)();
  const queued = { ...successful, status: 'queued', hasPdf: false, hasSynctex: false, finishedAt: null };
  harness.api.latestCompile.mockResolvedValueOnce({ job: queued });
  const poll = deferred<{ job: CompileJob }>();
  harness.api.latestCompile.mockReturnValue(poll.promise);
  openWorkspace();
  await screen.findByText('Test manuscript');
  await waitFor(() => expect(interval.mock.calls.some(([, delay]) => delay === 1400)).toBe(true));
  act(() => { pollTick(); });
  expect(harness.api.latestCompile).toHaveBeenCalledTimes(2);
  await act(async () => { harness.onEvent!({ type: 'compile.ready', job: successful }); });
  await act(async () => { poll.resolve({ job: { ...successful, status: 'compiling', hasPdf: false, hasSynctex: false, finishedAt: null } }); });
  expect(screen.getByRole('button', { name: /^succeeded/ })).toBeInTheDocument();
  expect(harness.api.compilePdf).toHaveBeenCalledTimes(1);
});

it('does not overlap slow polls and recovers from a failed status check without resubmitting', async () => {
  const interval = vi.spyOn(window, 'setInterval');
  const pollTick = () => (interval.mock.calls.find(([, delay]) => delay === 1400)![0] as () => void)();
  const queued = { ...successful, status: 'queued', hasPdf: false, hasSynctex: false, finishedAt: null };
  const failedPoll = deferred<{ job: CompileJob }>();
  harness.api.latestCompile.mockResolvedValueOnce({ job: queued }).mockReturnValueOnce(failedPoll.promise).mockResolvedValue({ job: successful });
  openWorkspace();
  await screen.findByText('Test manuscript');
  await waitFor(() => expect(interval.mock.calls.some(([, delay]) => delay === 1400)).toBe(true));
  act(() => { pollTick(); pollTick(); });
  expect(harness.api.latestCompile).toHaveBeenCalledTimes(2);
  await act(async () => { failedPoll.reject(new Error('Status connection interrupted')); });
  expect(screen.getByText('Status connection interrupted')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^queued/ })).toBeInTheDocument();
  await act(async () => { pollTick(); });
  expect(screen.getByRole('button', { name: /^succeeded/ })).toBeInTheDocument();
  expect(screen.queryByText('Status connection interrupted')).not.toBeInTheDocument();
  expect(harness.api.compile).not.toHaveBeenCalled();
  expect(harness.api.compilePdf).toHaveBeenCalledTimes(1);
});

it('retries a failed PDF download on the next readiness notification', async () => {
  harness.api.compilePdf.mockRejectedValueOnce(new Error('PDF download interrupted'));
  openWorkspace();
  await screen.findByText('Test manuscript');
  await act(async () => { harness.onEvent!({ type: 'compile.ready', job: successful }); });
  expect(screen.getByText('PDF download interrupted')).toBeInTheDocument();
  await act(async () => { harness.onEvent!({ type: 'compile.ready', job: successful }); });
  expect(screen.getByText('PDF good-revision SyncTeX good-job')).toBeInTheDocument();
  expect(screen.queryByText('PDF download interrupted')).not.toBeInTheDocument();
  expect(harness.api.compilePdf).toHaveBeenCalledTimes(2);
});

it('preserves the latest PDF when an older download finishes afterward', async () => {
  openWorkspace();
  await screen.findByText('Test manuscript');
  const oldDownload = deferred<{ data: ArrayBuffer }>();
  harness.api.compilePdf.mockReturnValueOnce(oldDownload.promise);
  act(() => { harness.onEvent!({ type: 'compile.ready', job: successful }); });
  const newer = { ...successful, id: 'new-good-job', sourceHash: 'new-revision', createdAt: '2026-10-19T10:00:02.000Z' };
  await act(async () => { harness.onEvent!({ type: 'compile.ready', job: newer }); });
  expect(screen.getByText('PDF new-revision SyncTeX new-good-job')).toBeInTheDocument();
  await act(async () => { oldDownload.resolve({ data: new ArrayBuffer(1) }); });
  expect(screen.getByText('PDF new-revision SyncTeX new-good-job')).toBeInTheDocument();
});

it('isolates PDF and compile state when navigating directly between projects', async () => {
  harness.api.latestCompile.mockResolvedValueOnce({ job: successful });
  function Navigation() {
    const navigate = useNavigate();
    return <button onClick={() => navigate('/project/other')}>Open another project</button>;
  }
  render(<MemoryRouter initialEntries={['/project/project']}><Navigation/><Routes><Route path="/project/:hash" element={<WorkspacePage/>}/></Routes></MemoryRouter>);
  await screen.findByText('PDF good-revision SyncTeX good-job');
  fireEvent.click(screen.getByRole('button', { name: 'Open another project' }));
  await screen.findByText('Test manuscript');
  expect(screen.getByText('No PDF loaded')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Not compiled' })).toBeInTheDocument();
  expect(harness.api.compilePdf).toHaveBeenCalledTimes(1);
});

it('keeps the newest good preview when an older project snapshot arrives after a later failure', async () => {
  const initial = deferred<{ job: CompileJob; lastSuccessfulJob: CompileJob }>();
  harness.api.latestCompile.mockReturnValueOnce(initial.promise);
  openWorkspace();
  const newer = { ...successful, id: 'new-good-job', sourceHash: 'new-revision', createdAt: '2026-10-19T10:00:02.000Z' };
  await act(async () => { harness.onEvent!({ type: 'compile.ready', job: newer }); });
  const failed = { ...newer, id: 'latest-failed-job', status: 'failed' as const, hasPdf: false, hasSynctex: false, createdAt: '2026-10-19T10:00:04.000Z' };
  act(() => { harness.onEvent!({ type: 'compile.failed', job: failed }); });
  await act(async () => { initial.resolve({ job: { ...successful, status: 'failed', hasPdf: false }, lastSuccessfulJob: successful }); });
  await screen.findByText('PDF new-revision SyncTeX new-good-job');
  expect(screen.getByRole('button', { name: /^failed/ })).toBeInTheDocument();
  expect(harness.api.compilePdf).toHaveBeenCalledTimes(1);
  expect(harness.api.compilePdf).toHaveBeenCalledWith('project', 'new-good-job');
});
