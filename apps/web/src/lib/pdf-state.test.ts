import { beforeEach, describe, expect, it } from 'vitest';
import {
  capturePdfViewState, loadStoredPdfViewState, restorePdfViewState, storePdfViewState
} from './pdf-state';

const values = new Map<string, string>();
const storage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => { values.set(key, value); }
};

describe('PDF view-state preservation', () => {
  beforeEach(() => values.clear());

  it('captures exact scroll coordinates, zoom, and current page', () => {
    const state = capturePdfViewState({ scrollTop: 1834.5, scrollLeft: 127 }, 1.35, 7);
    expect(state).toEqual({ scrollTop: 1834.5, scrollLeft: 127, zoom: 1.35, page: 7 });
  });

  it('restores exact scroll coordinates after replacement', () => {
    const element = { scrollTop: 0, scrollLeft: 0 };
    restorePdfViewState(element, { scrollTop: 991.25, scrollLeft: 83.75, zoom: 1.1, page: 3 });
    expect(element.scrollTop).toBe(991.25);
    expect(element.scrollLeft).toBe(83.75);
  });

  it('stores exact PDF state separately for each project', () => {
    const state = { scrollTop: 1834.5, scrollLeft: 127.25, zoom: 1.4, page: 4 };
    storePdfViewState('project-a', state, storage);
    expect(loadStoredPdfViewState('project-a', 1, storage)).toEqual(state);
    expect(loadStoredPdfViewState('project-b', 0.5, storage)).toEqual({ scrollTop: 0, scrollLeft: 0, zoom: 0.5, page: 1 });
  });

  it('ignores corrupt or out-of-range stored PDF state', () => {
    storage.setItem('overroot.pdfView.project-a', '{bad json');
    expect(loadStoredPdfViewState('project-a', 1, storage)).toEqual({ scrollTop: 0, scrollLeft: 0, zoom: 1, page: 1 });
    storage.setItem('overroot.pdfView.project-a', JSON.stringify({ scrollTop: -1, scrollLeft: 0, zoom: 9, page: 0 }));
    expect(loadStoredPdfViewState('project-a', 1, storage)).toEqual({ scrollTop: 0, scrollLeft: 0, zoom: 1, page: 1 });
  });
});
