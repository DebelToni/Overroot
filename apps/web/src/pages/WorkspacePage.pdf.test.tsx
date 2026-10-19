import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WorkspacePage } from './WorkspacePage';

const harness = vi.hoisted(() => ({
  api: { getProject: vi.fn(), listFiles: vi.fn(), latestCompile: vi.fn(), getFile: vi.fn(), compilePdf: vi.fn() }
}));
vi.mock('../lib/session', () => ({ useSession: () => ({ api: harness.api, user: { displayName: 'Writer' }, clearSession: vi.fn() }) }));
vi.mock('../hooks/useTheme', () => ({ useTheme: () => ({ preference: 'light', resolved: 'light', setPreference: vi.fn() }) }));
vi.mock('../hooks/useProjectEvents', () => ({ useProjectEvents: vi.fn() }));
vi.mock('../components/PdfViewer', () => ({ PdfViewer: ({ data, revision, synctexJobId }: { data: ArrayBuffer | null; revision: string; synctexJobId: string }) => <div>{data ? `PDF ${revision} SyncTeX ${synctexJobId}` : 'No PDF loaded'}</div> }));
vi.mock('../components/ManuscriptPane', () => ({ ManuscriptPane: () => <div>Test manuscript</div> }));
vi.mock('../components/EditorPane', () => ({ EditorPane: () => null }));
vi.mock('../components/WorkspaceDialogs', () => ({ AgentDialog: () => null, CompileLogDrawer: () => null, FileActionsDialog: () => null, HistoryDrawer: () => null, NewFileDialog: () => null, ProjectSettingsDialog: () => null, ShareDialog: () => null }));

const successful = { id: 'good-job', status: 'succeeded', sourceHash: 'good-revision', hasPdf: true, hasSynctex: true, createdAt: new Date().toISOString() };
beforeEach(() => {
  vi.clearAllMocks();
  harness.api.getProject.mockResolvedValue({ project: { hash: 'project', name: 'Paper', entryFile: 'main.tex', role: 'owner', canWrite: true, canManage: true, memberCount: 1 } });
  harness.api.listFiles.mockResolvedValue({ files: [] });
  harness.api.compilePdf.mockResolvedValue({ data: new ArrayBuffer(1) });
});
afterEach(cleanup);
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
