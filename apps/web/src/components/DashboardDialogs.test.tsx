import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { NewProjectDialog } from './DashboardDialogs';

vi.mock('./Modal', () => ({ Modal: ({ open, children }: { open: boolean; children: import('react').ReactNode }) => open ? <div role="dialog">{children}</div> : null }));
afterEach(cleanup);

it('keeps creation progress active until completion and allows retry after failure', async () => {
  let reject!: (reason: Error) => void;
  const pending = new Promise<void>((_done, fail) => { reject = fail; });
  const onCreate = vi.fn().mockReturnValueOnce(pending).mockResolvedValueOnce(undefined);
  const onClose = vi.fn();
  render(<NewProjectDialog open templates={[{ id: 'article', name: 'Article', description: 'A paper', entryFile: 'main.tex' }]} onCreate={onCreate} onClose={onClose}/>);
  const form = screen.getByLabelText('Project name').closest('form')!;
  fireEvent.submit(form);
  const creatingButton = screen.getByRole('button', { name: 'Creating project…' });
  expect(creatingButton).toBeDisabled();
  expect(creatingButton).toHaveAttribute('aria-label', 'Creating project…');
  expect(creatingButton).toHaveAccessibleName('Creating project…');
  expect(screen.getByRole('status')).toHaveTextContent('Creating project…');
  fireEvent.submit(form);
  expect(onCreate).toHaveBeenCalledTimes(1);
  expect(onClose).not.toHaveBeenCalled();

  await act(async () => { reject(new Error('Could not create project')); });
  expect(screen.getByRole('alert')).toHaveTextContent('Could not create project');
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Create project' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Create project' })).not.toHaveAttribute('aria-label');
  await act(async () => { fireEvent.submit(form); });
  expect(onCreate).toHaveBeenLastCalledWith('Untitled paper', 'article');
  expect(onClose).toHaveBeenCalledTimes(1);
});
