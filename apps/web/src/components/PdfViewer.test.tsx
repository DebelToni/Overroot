import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
function document(numPages = 1) {
  return { numPages, getPage: vi.fn(async () => ({ getViewport: ({ scale }: { scale: number }) => ({ width: 200 * scale, height: 300 * scale }) })) };
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
  window.localStorage.clear();
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

async function gestureViewer(focusMode = true, numPages = 1) {
  parser.getDocument.mockImplementation(() => ({ promise: Promise.resolve(document(numPages)), destroy: vi.fn() }));
  const props = properties();
  const view = render(<PdfViewer {...props} focusMode={focusMode}/>);
  // The callback runs before React commits rendering=false and installs touch listeners.
  await act(async () => {
    await waitFor(() => expect(props.onDocumentStatus).toHaveBeenCalledWith(props.data, 'ready'));
  });
  const root = view.container.querySelector<HTMLDivElement>('.pdf-scroll')!;
  const page = screen.getByLabelText('PDF page 1');
  vi.spyOn(root, 'getBoundingClientRect').mockReturnValue({ left: 10, top: 20 } as DOMRect);
  [...view.container.querySelectorAll<HTMLElement>('.pdf-page')].forEach((element, index, elements) => {
    Object.defineProperties(element, {
      offsetLeft: { get: () => 16 },
      offsetTop: { get: () => 35 + elements.slice(0, index).reduce((top, previous) => top + parseFloat(previous.style.height) + 18, 0) },
      offsetHeight: { get: () => parseFloat(element.style.height) }
    });
  });
  root.scrollLeft = 60;
  root.scrollTop = 90;
  return { ...view, root, page, props };
}
const fingers = (left: number, right: number, y = 170) => [
  { identifier: 1, clientX: left, clientY: y }, { identifier: 2, clientX: right, clientY: y }
];

it('previews a fullscreen pinch at its moving midpoint and renders sharp pages only on release', async () => {
  const { root, page } = await gestureViewer();
  expect(fireEvent.touchStart(root, { touches: fingers(60, 160) })).toBe(false);
  fireEvent.touchMove(root, { touches: fingers(30, 230, 200) });
  expect(page.style.width).toBe('400px');
  expect(page.querySelector('canvas')!.style.height).toBe('600px');
  expect(root.scrollLeft).toBe(184);
  expect(root.scrollTop).toBe(265);
  expect(parser.getDocument).toHaveBeenCalledTimes(1);
  fireEvent.touchEnd(root, { touches: [] });
  await waitFor(() => expect(screen.getByText('200%')).toBeInTheDocument());
  await waitFor(() => expect(parser.getDocument).toHaveBeenCalledTimes(2));
  expect(screen.getByLabelText('PDF page 1').style.width).toBe('400px');
  expect(root.scrollLeft).toBe(184);
  expect(root.scrollTop).toBe(265);
  expect(JSON.parse(window.localStorage.getItem('overroot.pdfView.pdf-validation-test')!)).toMatchObject({ zoom: 2, scrollLeft: 184, scrollTop: 265 });
});

it('keeps a later page under the fingers as preceding pages grow', async () => {
  const { root } = await gestureViewer(true, 2);
  root.scrollTop = 400;
  fireEvent.touchStart(root, { touches: fingers(60, 160) });
  fireEvent.touchMove(root, { touches: fingers(10, 210) });
  expect(root.scrollTop).toBe(897);
  fireEvent.touchEnd(root, { touches: [] });
  await waitFor(() => expect(parser.getDocument).toHaveBeenCalledTimes(2));
  expect(root.scrollTop).toBe(897);
  expect(screen.getByLabelText('PDF page 2').style.height).toBe('600px');
});

it('commits the preview when leaving fullscreen during a pinch', async () => {
  const { root, props, rerender } = await gestureViewer();
  fireEvent.touchStart(root, { touches: fingers(60, 160) });
  fireEvent.touchMove(root, { touches: fingers(10, 210) });
  expect(screen.getByLabelText('PDF page 1').style.width).toBe('400px');
  rerender(<PdfViewer {...props} focusMode={false}/>);
  await screen.findByText('200%');
  await waitFor(() => expect(parser.getDocument).toHaveBeenCalledTimes(2));
  expect(screen.getByLabelText('PDF page 1').style.width).toBe('400px');
  expect(fireEvent.touchStart(root, { touches: fingers(60, 160) })).toBe(true);
});

it.each([
  { left: -140, right: 360, width: '500px', readout: '250%' },
  { left: 105, right: 115, width: '100px', readout: '50%' }
])('clamps pinch zoom to $readout and commits on cancellation', async ({ left, right, width, readout }) => {
  const { root, page } = await gestureViewer();
  fireEvent.touchStart(root, { touches: fingers(60, 160) });
  fireEvent.touchMove(root, { touches: fingers(left, right) });
  expect(page.style.width).toBe(width);
  fireEvent.touchCancel(root, { touches: [] });
  await screen.findByText(readout);
  await waitFor(() => expect(parser.getDocument).toHaveBeenCalledTimes(2));
});

it('ends a pinch when a third finger joins and ignores a replacement pair', async () => {
  const { root } = await gestureViewer();
  fireEvent.touchStart(root, { touches: fingers(60, 160) });
  fireEvent.touchMove(root, { touches: fingers(10, 210) });
  const third = { identifier: 3, clientX: 300, clientY: 170 };
  fireEvent.touchStart(root, { touches: [...fingers(10, 210), third] });
  const replacement = [fingers(10, 210)[1]!, third];
  fireEvent.touchEnd(root, { touches: replacement });
  fireEvent.touchMove(root, { touches: [replacement[0]!, { ...third, clientX: 500 }] });
  await screen.findByText('200%');
  await waitFor(() => expect(parser.getDocument).toHaveBeenCalledTimes(2));
  expect(screen.getByLabelText('PDF page 1').style.width).toBe('400px');
});

it.each(['touchEnd', 'touchMove', 'touchCancel'] as const)('ends the active pinch on %s with a changed or cancelled pair', async (event) => {
  const { root } = await gestureViewer();
  fireEvent.touchStart(root, { touches: fingers(60, 160) });
  fireEvent.touchMove(root, { touches: fingers(10, 210) });
  const remaining = fingers(10, 210);
  if (event !== 'touchCancel') remaining[1]!.identifier = 3;
  fireEvent[event](root, { touches: remaining });
  await screen.findByText('200%');
  await waitFor(() => expect(parser.getDocument).toHaveBeenCalledTimes(2));
  fireEvent.touchMove(root, { touches: fingers(-100, 300) });
  expect(screen.getByLabelText('PDF page 1').style.width).toBe('400px');
  expect(parser.getDocument).toHaveBeenCalledTimes(2);
});

it('accepts reordered touches belonging to the same active pair', async () => {
  const { root, page } = await gestureViewer();
  fireEvent.touchStart(root, { touches: fingers(60, 160) });
  fireEvent.touchMove(root, { touches: fingers(10, 210).reverse() });
  expect(page.style.width).toBe('400px');
  fireEvent.touchEnd(root, { touches: [] });
  await screen.findByText('200%');
});

it('leaves ordinary one-finger scrolling to the browser', async () => {
  const { root, page } = await gestureViewer();
  expect(fireEvent.touchStart(root, { touches: fingers(60, 160).slice(0, 1) })).toBe(true);
  expect(fireEvent.touchMove(root, { touches: fingers(80, 180).slice(0, 1) })).toBe(true);
  fireEvent.scroll(root, { target: { scrollLeft: 100, scrollTop: 150 } });
  expect(page.style.width).toBe('200px');
  expect(parser.getDocument).toHaveBeenCalledTimes(1);
});

it('does not intercept pinches outside fullscreen', async () => {
  const { root, page } = await gestureViewer(false);
  expect(fireEvent.touchStart(root, { touches: fingers(60, 160) })).toBe(true);
  expect(fireEvent.touchMove(root, { touches: fingers(10, 210) })).toBe(true);
  fireEvent.touchEnd(root, { touches: [] });
  expect(page.style.width).toBe('200px');
  expect(parser.getDocument).toHaveBeenCalledTimes(1);
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
