const STORAGE_PREFIX = 'overroot.pdfView.';
type StateStorage = Pick<Storage, 'getItem' | 'setItem'>;

export interface PdfViewState {
  scrollTop: number;
  scrollLeft: number;
  zoom: number;
  page: number;
}

export interface ScrollElement {
  scrollTop: number;
  scrollLeft: number;
}

export function capturePdfViewState(element: ScrollElement | null, zoom: number, page: number): PdfViewState {
  return {
    scrollTop: element?.scrollTop ?? 0,
    scrollLeft: element?.scrollLeft ?? 0,
    zoom,
    page
  };
}

export function restorePdfViewState(element: ScrollElement | null, state: PdfViewState): void {
  if (!element) return;
  element.scrollTop = state.scrollTop;
  element.scrollLeft = state.scrollLeft;
}

export function loadStoredPdfViewState(projectHash: string, defaultZoom: number, storage: StateStorage = window.localStorage): PdfViewState {
  const fallback = { scrollTop: 0, scrollLeft: 0, zoom: defaultZoom, page: 1 };
  const raw = storage.getItem(`${STORAGE_PREFIX}${projectHash}`);
  if (!raw) return fallback;
  try {
    const value = JSON.parse(raw) as Partial<PdfViewState>;
    if (
      !validCoordinate(value.scrollTop) || !validCoordinate(value.scrollLeft) ||
      !Number.isFinite(value.zoom) || value.zoom! < 0.5 || value.zoom! > 2.5 ||
      !Number.isInteger(value.page) || value.page! < 1
    ) return fallback;
    return value as PdfViewState;
  } catch {
    return fallback;
  }
}

export function storePdfViewState(projectHash: string, state: PdfViewState, storage: StateStorage = window.localStorage): void {
  storage.setItem(`${STORAGE_PREFIX}${projectHash}`, JSON.stringify(state));
}

export function afterLayout(callback: () => void): void {
  requestAnimationFrame(() => requestAnimationFrame(callback));
}

function validCoordinate(value: number | undefined): value is number {
  return Number.isFinite(value) && value! >= 0;
}
