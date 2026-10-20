import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DashboardPage } from './DashboardPage';

const harness = vi.hoisted(() => ({
  api: { listProjects: vi.fn(), listTemplates: vi.fn(), importProject: vi.fn(), createProject: vi.fn(), url: (path: string) => `https://overroot.toni.foo${path}` },
  user: { username: 'writer', displayName: 'Writer', isAdmin: false }
}));
vi.mock('../lib/session', () => ({ useSession: () => ({ api: harness.api, user: harness.user, clearSession: vi.fn() }) }));
vi.mock('../hooks/useTheme', () => ({ useTheme: () => ({ preference: 'light', setPreference: vi.fn() }) }));
vi.mock('../components/Modal', () => ({ Modal: ({ open, children }: { open: boolean; children: import('react').ReactNode }) => open ? <div role="dialog">{children}</div> : null }));

beforeEach(() => {
  vi.resetAllMocks();
  harness.api.listProjects.mockResolvedValue({ projects: [] });
  harness.api.listTemplates.mockResolvedValue({ templates: [] });
});
afterEach(cleanup);

it('preserves a dismissed creation draft and its progress when reopened', async () => {
  let reject!: (reason: Error) => void;
  harness.api.createProject.mockReturnValueOnce(new Promise<never>((_done, fail) => { reject = fail; }));
  render(<MemoryRouter><DashboardPage/></MemoryRouter>);
  await screen.findByText('No projects yet.');
  fireEvent.click(screen.getByRole('button', { name: 'New project' }));
  fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'My pending paper' } });
  fireEvent.submit(screen.getByLabelText('Project name').closest('form')!);
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Creating project…' }));
  expect(screen.getByLabelText('Project name')).toHaveValue('My pending paper');
  expect(screen.getByLabelText('Project name')).toBeDisabled();
  expect(harness.api.createProject).toHaveBeenCalledTimes(1);

  await act(async () => { reject(new Error('Creation unavailable')); });
  expect(screen.getByRole('alert')).toHaveTextContent('Creation unavailable');
  expect(screen.getByLabelText('Project name')).toBeEnabled();
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});

it('shows a created project on the dashboard instead of navigating after dismissal', async () => {
  let resolve!: (value: { project: { hash: string } }) => void;
  harness.api.createProject.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  render(<MemoryRouter><Routes><Route path="/" element={<DashboardPage/>}/><Route path="/project/created" element={<div>Created workspace</div>}/></Routes></MemoryRouter>);
  await screen.findByText('No projects yet.');
  fireEvent.click(screen.getByRole('button', { name: 'New project' }));
  fireEvent.submit(screen.getByLabelText('Project name').closest('form')!);
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  harness.api.listProjects.mockResolvedValueOnce({ projects: [{ hash: 'created', name: 'Created paper', entryFile: 'main.tex', owner: 'writer', role: 'owner', updatedAt: new Date().toISOString() }] });
  await act(async () => { resolve({ project: { hash: 'created' } }); });
  expect(await screen.findByText('Created paper')).toBeInTheDocument();
  expect(screen.queryByText('Created workspace')).not.toBeInTheDocument();
});

it('does not redirect a user who leaves the dashboard during an import', async () => {
  let resolve!: (value: { project: { hash: string } }) => void;
  harness.api.importProject.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  harness.api.listProjects.mockResolvedValueOnce({ projects: [{ hash: 'other', name: 'Other paper', entryFile: 'main.tex', owner: 'writer', role: 'owner', updatedAt: new Date().toISOString() }] });
  const current = render(<MemoryRouter><Routes><Route path="/" element={<DashboardPage/>}/><Route path="/project/other" element={<div>Other workspace</div>}/><Route path="/project/imported" element={<div>Imported workspace</div>}/></Routes></MemoryRouter>);
  await screen.findByText('Other paper');
  fireEvent.change(current.container.querySelector('input[type="file"]')!, { target: { files: [new File(['zip fixture'], 'paper.zip')] } });
  fireEvent.click(screen.getByRole('button', { name: /Other paper/ }));
  await screen.findByText('Other workspace');
  await act(async () => { resolve({ project: { hash: 'imported' } }); });
  expect(screen.getByText('Other workspace')).toBeInTheDocument();
  expect(screen.queryByText('Imported workspace')).not.toBeInTheDocument();
});

it('reports a dismissed creation failure on the dashboard and permits a fresh draft', async () => {
  let reject!: (reason: Error) => void;
  harness.api.createProject.mockReturnValueOnce(new Promise<never>((_done, fail) => { reject = fail; }));
  render(<MemoryRouter><DashboardPage/></MemoryRouter>);
  await screen.findByText('No projects yet.');
  fireEvent.click(screen.getByRole('button', { name: 'New project' }));
  fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'Failed paper' } });
  fireEvent.submit(screen.getByLabelText('Project name').closest('form')!);
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  await act(async () => { reject(new Error('Creation unavailable')); });
  expect(screen.getByRole('alert')).toHaveTextContent('Creation unavailable');
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'New project' }));
  expect(screen.getByLabelText('Project name')).toHaveValue('Untitled paper');
  expect(screen.getByLabelText('Project name')).toBeEnabled();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('does not redirect a user who leaves the dashboard during creation', async () => {
  let resolve!: (value: { project: { hash: string } }) => void;
  harness.api.createProject.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  harness.api.listProjects.mockResolvedValueOnce({ projects: [{ hash: 'other', name: 'Other paper', entryFile: 'main.tex', owner: 'writer', role: 'owner', updatedAt: new Date().toISOString() }] });
  render(<MemoryRouter><Routes><Route path="/" element={<DashboardPage/>}/><Route path="/project/other" element={<div>Other workspace</div>}/><Route path="/project/created" element={<div>Created workspace</div>}/></Routes></MemoryRouter>);
  await screen.findByText('Other paper');
  fireEvent.click(screen.getByRole('button', { name: 'New project' }));
  fireEvent.submit(screen.getByLabelText('Project name').closest('form')!);
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  fireEvent.click(screen.getByRole('button', { name: /Other paper/ }));
  await screen.findByText('Other workspace');
  await act(async () => { resolve({ project: { hash: 'created' } }); });
  expect(screen.getByText('Other workspace')).toBeInTheDocument();
  expect(screen.queryByText('Created workspace')).not.toBeInTheDocument();
});

it('keeps the refreshed project list when the initial dashboard load finishes late', async () => {
  let resolveInitial!: (value: { projects: [] }) => void;
  let resolveCreate!: (value: { project: { hash: string } }) => void;
  harness.api.listProjects.mockReturnValueOnce(new Promise((done) => { resolveInitial = done; }))
    .mockResolvedValueOnce({ projects: [{ hash: 'created', name: 'Created paper', entryFile: 'main.tex', owner: 'writer', role: 'owner', updatedAt: new Date().toISOString() }] });
  harness.api.createProject.mockReturnValueOnce(new Promise((done) => { resolveCreate = done; }));
  render(<MemoryRouter><DashboardPage/></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: 'New project' }));
  fireEvent.submit(screen.getByLabelText('Project name').closest('form')!);
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  await act(async () => { resolveCreate({ project: { hash: 'created' } }); });
  await screen.findByText('Created paper');
  await act(async () => { resolveInitial({ projects: [] }); });
  expect(screen.getByText('Created paper')).toBeInTheDocument();
  expect(screen.queryByText('No projects yet.')).not.toBeInTheDocument();
});

it('keeps import progress tied to the upload, then restores the action after an error', async () => {
  let reject!: (reason: Error) => void;
  const pending = new Promise<never>((_done, fail) => { reject = fail; });
  harness.api.importProject.mockReturnValueOnce(pending).mockResolvedValueOnce({ project: { hash: 'imported' } });
  const view = render(<MemoryRouter><Routes><Route path="/" element={<DashboardPage/>}/><Route path="/project/imported" element={<div>Imported workspace</div>}/></Routes></MemoryRouter>);
  await screen.findByText('No projects yet.');
  const input = view.container.querySelector('input[type="file"]')!;
  const file = new File(['zip fixture'], 'paper.zip', { type: 'application/zip' });
  fireEvent.change(input, { target: { files: [file] } });
  const importingButton = screen.getByRole('button', { name: 'Importing ZIP…' });
  expect(importingButton).toBeDisabled();
  expect(importingButton).toHaveAttribute('aria-label', 'Importing ZIP…');
  expect(importingButton).toHaveAccessibleName('Importing ZIP…');
  expect(screen.getByRole('status')).toHaveTextContent('Importing ZIP…');
  fireEvent.change(input, { target: { files: [file] } });
  expect(harness.api.importProject).toHaveBeenCalledTimes(1);

  await act(async () => { reject(new Error('Invalid archive')); });
  expect(screen.getByRole('alert')).toHaveTextContent('Invalid archive');
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Import ZIP' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Import ZIP' })).not.toHaveAttribute('aria-label');
  fireEvent.change(input, { target: { files: [file] } });
  await screen.findByText('Imported workspace');
  expect(harness.api.importProject).toHaveBeenCalledTimes(2);
});

it('exposes only an issuer-admin entry button for the preserved local admin affordance', async () => {
  harness.user.isAdmin = true;
  try {
    render(<MemoryRouter><DashboardPage/></MemoryRouter>);
    await screen.findByText('No projects yet.');
    const link = screen.getByRole('link', { name: 'Admin' });
    expect(link).toHaveAttribute('href', '/api/v1/auth/admin');
    expect(screen.queryByText(/Invitations|Approve accounts/)).toBeNull();
  } finally { harness.user.isAdmin = false; }
});
it('does not offer site administration to ordinary local users', async () => {
  render(<MemoryRouter><DashboardPage/></MemoryRouter>);
  await screen.findByText('No projects yet.');
  expect(screen.queryByRole('link', { name: 'Admin' })).toBeNull();
});
