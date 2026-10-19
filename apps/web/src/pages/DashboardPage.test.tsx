import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DashboardPage } from './DashboardPage';

const harness = vi.hoisted(() => ({
  api: { listProjects: vi.fn(), listTemplates: vi.fn(), importProject: vi.fn() },
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

it('keeps import progress tied to the upload, then restores the action after an error', async () => {
  let reject!: (reason: Error) => void;
  const pending = new Promise<never>((_done, fail) => { reject = fail; });
  harness.api.importProject.mockReturnValueOnce(pending).mockResolvedValueOnce({ project: { hash: 'imported' } });
  const view = render(<MemoryRouter><Routes><Route path="/" element={<DashboardPage/>}/><Route path="/project/imported" element={<div>Imported workspace</div>}/></Routes></MemoryRouter>);
  await screen.findByText('No projects yet.');
  const input = view.container.querySelector('input[type="file"]')!;
  const file = new File(['zip fixture'], 'paper.zip', { type: 'application/zip' });
  fireEvent.change(input, { target: { files: [file] } });
  expect(screen.getByRole('button', { name: 'Importing ZIP…' })).toBeDisabled();
  expect(screen.getByRole('status')).toHaveTextContent('Importing ZIP…');
  fireEvent.change(input, { target: { files: [file] } });
  expect(harness.api.importProject).toHaveBeenCalledTimes(1);

  await act(async () => { reject(new Error('Invalid archive')); });
  expect(screen.getByRole('alert')).toHaveTextContent('Invalid archive');
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Import ZIP' })).toBeEnabled();
  fireEvent.change(input, { target: { files: [file] } });
  await screen.findByText('Imported workspace');
  expect(harness.api.importProject).toHaveBeenCalledTimes(2);
});
