import { ChevronLeft, ChevronRight, Download, Maximize2, Minus, Plus, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist';
import type { ApiClient } from '../lib/api';
import { paintPdfHighlights } from '../lib/pdf-highlight';
import {
  afterLayout, capturePdfViewState, loadStoredPdfViewState, restorePdfViewState,
  storePdfViewState, type PdfViewState
} from '../lib/pdf-state';
import type { SourceLocation, SyncTexHighlight } from '../types';

GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();

export function PdfViewer({
  api,
  projectHash,
  data,
  revision,
  synctexJobId,
  sourceLocation,
  loading,
  focusMode,
  onFocusMode,
  projectName,
  onDocumentStatus
}: {
  api: ApiClient;
  projectHash: string;
  data: ArrayBuffer | null;
  revision: string | null;
  synctexJobId: string | null;
  sourceLocation: SourceLocation | null;
  loading: boolean;
  focusMode: boolean;
  onFocusMode: (focused: boolean) => void;
  projectName: string;
  onDocumentStatus?: (data: ArrayBuffer, status: 'ready' | 'failed') => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const pages = useRef<HTMLDivElement>(null);
  const [initialView] = useState(() => loadStoredPdfViewState(projectHash, window.innerWidth <= 720 ? 0.5 : 1));
  const preserved = useRef<PdfViewState>(initialView);
  const saveTimer = useRef<number | null>(null);
  const canPersist = useRef(false);
  const [zoom, setZoom] = useState(initialView.zoom);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const [page, setPage] = useState(initialView.page);
  const [pageCount, setPageCount] = useState(0);
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sourceHighlights, setSourceHighlights] = useState<SyncTexHighlight[]>([]);
  const documentStatus = useRef(onDocumentStatus);
  documentStatus.current = onDocumentStatus;

  useEffect(() => {
    if (!data || !pages.current) {
      if (pages.current) pages.current.replaceChildren();
      setPageCount(0);
      return;
    }
    let cancelled = false;
    const task = getDocument({ data: new Uint8Array(data.slice(0)) });
    setRendering(true);
    setError(null);

    void task.promise
      .then(async (pdf) => {
        if (cancelled || !pages.current) return;
        setPageCount(pdf.numPages);
        const fragment = document.createDocumentFragment();
        const renderJobs: Promise<unknown>[] = [];
        for (let number = 1; number <= pdf.numPages; number += 1) {
          const pdfPage = await pdf.getPage(number);
          if (cancelled) return;
          const viewport = pdfPage.getViewport({ scale: zoom });
          const ratio = Math.min(window.devicePixelRatio || 1, 2);
          const wrapper = document.createElement('div');
          wrapper.className = 'pdf-page';
          wrapper.dataset.page = String(number);
          wrapper.style.width = `${viewport.width}px`;
          wrapper.style.height = `${viewport.height}px`;
          wrapper.setAttribute('aria-label', `PDF page ${number}`);
          const canvas = document.createElement('canvas');
          canvas.width = Math.floor(viewport.width * ratio);
          canvas.height = Math.floor(viewport.height * ratio);
          canvas.style.width = `${viewport.width}px`;
          canvas.style.height = `${viewport.height}px`;
          wrapper.append(canvas);
          fragment.append(wrapper);
          const context = canvas.getContext('2d');
          if (context) {
            renderJobs.push(pdfPage.render({ canvas, canvasContext: context, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] }).promise);
          }
        }
        if (pages.current.childElementCount) preserved.current = capturePdfViewState(scroller.current, zoom, visiblePage());
        canPersist.current = false;
        pages.current.replaceChildren(fragment);
        await Promise.all(renderJobs);
        if (cancelled) return;
        setRendering(false);
        documentStatus.current?.(data, 'ready');
        setPage(Math.min(preserved.current.page, pdf.numPages));
        afterLayout(() => {
          if (cancelled) return;
          restorePdfViewState(scroller.current, preserved.current);
          canPersist.current = true;
          persistViewState();
        });
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        canPersist.current = Boolean(pages.current?.childElementCount);
        setRendering(false);
        setError(reason instanceof Error ? reason.message : 'The PDF could not be displayed');
        documentStatus.current?.(data, 'failed');
      });

    return () => {
      cancelled = true;
      void task.destroy();
    };
  }, [data, revision, zoom]);

  useEffect(() => {
    let cancelled = false;
    setSourceHighlights([]);
    if (!synctexJobId || !sourceLocation || !data) return;
    const timer = window.setTimeout(() => {
      void api.locateSource(projectHash, synctexJobId, sourceLocation.path, sourceLocation.line)
        .then((result) => { if (!cancelled) setSourceHighlights(result.highlights); })
        .catch(() => { if (!cancelled) setSourceHighlights([]); });
    }, 100);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [api, data, projectHash, sourceLocation?.line, sourceLocation?.path, synctexJobId]);

  useEffect(() => {
    paintPdfHighlights(pages.current, sourceHighlights, zoom);
  }, [rendering, revision, sourceHighlights, zoom]);

  useEffect(() => {
    if (!focusMode) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onFocusMode(false);
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [focusMode, onFocusMode]);

  useEffect(() => {
    const flush = () => {
      if (saveTimer.current != null) window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
      persistViewState();
    };
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, [projectHash]);

  function visiblePage() {
    const root = scroller.current;
    if (!root) return 1;
    const top = root.scrollTop + 24;
    let current = 1;
    for (const element of pages.current?.querySelectorAll<HTMLElement>('[data-page]') ?? []) {
      if (element.offsetTop <= top) current = Number(element.dataset.page);
      else break;
    }
    return current;
  }

  function persistViewState() {
    if (!canPersist.current) return;
    const state = capturePdfViewState(scroller.current, zoomRef.current, visiblePage());
    preserved.current = state;
    storePdfViewState(projectHash, state);
  }

  function scheduleViewStateSave() {
    if (saveTimer.current != null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null;
      persistViewState();
    }, 150);
  }

  function trackPage() {
    setPage(visiblePage());
    scheduleViewStateSave();
  }

  function adjustZoom(delta: number) {
    const next = Math.min(2.5, Math.max(0.5, Math.round((zoom + delta) * 10) / 10));
    if (next === zoom) return;
    zoomRef.current = next;
    setZoom(next);
    canPersist.current = true;
    persistViewState();
  }

  function goToPage(next: number) {
    const target = pages.current?.querySelector<HTMLElement>(`[data-page="${next}"]`);
    if (!target || !scroller.current) return;
    scroller.current.scrollTo({ top: target.offsetTop - 18, behavior: 'smooth' });
    setPage(next);
  }

  function download() {
    if (!data) return;
    const url = URL.createObjectURL(new Blob([data], { type: 'application/pdf' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${projectName.replace(/[^a-z0-9_.-]+/gi, '-') || 'document'}.pdf`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <section className={`pdf-viewer ${focusMode ? 'pdf-viewer--focus' : ''}`} aria-label="PDF preview">
      <div className="pdf-toolbar">
        <span className="pane-title">PDF</span>
        <div className="pdf-toolbar__group" aria-label="Page controls">
          <button type="button" className="icon-button" disabled={page <= 1} onClick={() => goToPage(page - 1)} aria-label="Previous page"><ChevronLeft size={15}/></button>
          <span className="pdf-readout">{pageCount ? `${page} / ${pageCount}` : '— / —'}</span>
          <button type="button" className="icon-button" disabled={page >= pageCount} onClick={() => goToPage(page + 1)} aria-label="Next page"><ChevronRight size={15}/></button>
        </div>
        <div className="pdf-toolbar__group" aria-label="Zoom controls">
          <button type="button" className="icon-button" disabled={zoom <= 0.5} onClick={() => adjustZoom(-0.1)} aria-label="Zoom out"><Minus size={14}/></button>
          <span className="pdf-readout">{Math.round(zoom * 100)}%</span>
          <button type="button" className="icon-button" disabled={zoom >= 2.5} onClick={() => adjustZoom(0.1)} aria-label="Zoom in"><Plus size={14}/></button>
        </div>
        <span className="pdf-toolbar__spacer"/>
        <button type="button" className="icon-button" disabled={!data} onClick={download} aria-label="Download PDF"><Download size={15}/></button>
        <button type="button" className="icon-button" onClick={() => onFocusMode(!focusMode)} aria-label={focusMode ? 'Return to editor' : 'Show only PDF'}>
          {focusMode ? <X size={16}/> : <Maximize2 size={15}/>} 
        </button>
      </div>
      <div ref={scroller} className="pdf-scroll" onScroll={trackPage}>
        {!data && !loading && <div className="pdf-empty"><strong>No PDF yet.</strong><span>Compile the project to see it here.</span></div>}
        {(loading || rendering) && <div className="pdf-loading"><span className="status-dot status-dot--working"/> Rendering PDF…</div>}
        {error && <div className="pdf-empty pdf-empty--error"><strong>Preview failed.</strong><span>{error}</span></div>}
        <div ref={pages} className="pdf-pages"/>
      </div>
      {focusMode && <button type="button" className="pdf-focus-back" onClick={() => onFocusMode(false)}><X size={14}/> Back to editor <kbd>Esc</kbd></button>}
    </section>
  );
}
