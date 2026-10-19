import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ApiClient } from '../lib/api';
import { PdfViewer } from './PdfViewer';

const parser = vi.hoisted(() => ({ getDocument: vi.fn() }));
vi.mock('pdfjs-dist', () => ({ GlobalWorkerOptions: {}, getDocument: parser.getDocument }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function document() {
  return { numPages: 1, getPage: vi.fn(async () => ({ getViewport: () => ({ width: 200, height: 300 }) })) };
}
function properties(data = new ArrayBuffer(1)) {
  return {
    api: {} as ApiClient, projectHash: 'pdf-validation-test', data, revision: 'source', synctexJobId: null,
    sourceLocation: null, loading: false, focusMode: false, onFocusMode: vi.fn(), projectName: 'Paper',
    onDocumentStatus: vi.fn()
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('reports parser rejection with the exact downloaded buffer identity', async () => {
  const props = properties(new Uint8Array([0]).buffer);
  parser.getDocument.mockImplementation(() => ({ promise: Promise.reject(new Error('Invalid PDF structure')), destroy: vi.fn() }));
  render(<PdfViewer {...props}/>);
  await screen.findByText('Invalid PDF structure');
  expect(props.onDocumentStatus).toHaveBeenCalledExactlyOnceWith(props.data, 'failed');
});

it('confirms usable bytes after pages finish loading', async () => {
  const props = properties();
  parser.getDocument.mockImplementation(() => ({ promise: Promise.resolve(document()), destroy: vi.fn() }));
  render(<PdfViewer {...props}/>);
  await waitFor(() => expect(props.onDocumentStatus).toHaveBeenCalledExactlyOnceWith(props.data, 'ready'));
  expect(screen.getByLabelText('PDF page 1')).toBeInTheDocument();
});

it('does not report a cancelled old parser failure against replacement bytes', async () => {
  const first = deferred<ReturnType<typeof document>>();
  parser.getDocument.mockReturnValueOnce({ promise: first.promise, destroy: vi.fn() });
  parser.getDocument.mockImplementation(() => ({ promise: Promise.resolve(document()), destroy: vi.fn() }));
  const props = properties();
  const view = render(<PdfViewer {...props}/>);
  const replacement = new ArrayBuffer(2);
  view.rerender(<PdfViewer {...props} data={replacement}/>);
  await waitFor(() => expect(props.onDocumentStatus).toHaveBeenCalledWith(replacement, 'ready'));
  await act(async () => { first.reject(new Error('Old PDF was invalid')); });
  expect(props.onDocumentStatus).not.toHaveBeenCalledWith(props.data, 'failed');
  expect(screen.queryByText('Old PDF was invalid')).not.toBeInTheDocument();
});

it('uses the latest validation callback without restarting a pending document', async () => {
  const pending = deferred<ReturnType<typeof document>>();
  parser.getDocument.mockReturnValue({ promise: pending.promise, destroy: vi.fn() });
  const props = properties();
  const view = render(<PdfViewer {...props}/>);
  const onDocumentStatus = vi.fn();
  view.rerender(<PdfViewer {...props} onDocumentStatus={onDocumentStatus}/>);
  await act(async () => { pending.resolve(document()); });
  expect(parser.getDocument).toHaveBeenCalledTimes(1);
  expect(onDocumentStatus).toHaveBeenCalledExactlyOnceWith(props.data, 'ready');
  expect(props.onDocumentStatus).not.toHaveBeenCalled();
});
