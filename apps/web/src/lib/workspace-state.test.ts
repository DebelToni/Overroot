import { beforeEach, describe, expect, it } from 'vitest';
import {
  loadEditorPercent, loadTreeOpen, loadWorkspaceSource, storeEditorPercent, storeTreeOpen, storeWorkspaceSource
} from './workspace-state';

const values = new Map<string, string>();
const storage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => { values.set(key, value); }
};

describe('workspace source persistence', () => {
  beforeEach(() => values.clear());

  it('defaults to no remembered source and stores both file and mode', () => {
    expect(loadWorkspaceSource('writer', 'paper', storage)).toBeNull();
    const source = { fileId: 'chapter', mode: 'files' as const };
    storeWorkspaceSource('writer', 'paper', source, storage);
    expect(loadWorkspaceSource('writer', 'paper', storage)).toEqual(source);
  });

  it('keeps accounts and projects separate', () => {
    storeWorkspaceSource('writer', 'paper', { fileId: 'chapter', mode: 'files' }, storage);
    storeWorkspaceSource('writer', 'other-paper', { fileId: 'appendix', mode: 'manuscript' }, storage);
    storeWorkspaceSource('reader', 'paper', { fileId: 'intro', mode: 'manuscript' }, storage);
    expect(loadWorkspaceSource('writer', 'paper', storage)).toEqual({ fileId: 'chapter', mode: 'files' });
    expect(loadWorkspaceSource('writer', 'other-paper', storage)).toEqual({ fileId: 'appendix', mode: 'manuscript' });
    expect(loadWorkspaceSource('reader', 'paper', storage)).toEqual({ fileId: 'intro', mode: 'manuscript' });
  });

  it.each(['{', 'null', '[]', '42', '{"fileId":"chapter","mode":"invalid"}', '{"fileId":5,"mode":"files"}', '{"fileId":"","mode":"files"}'])('ignores invalid saved data: %s', (value) => {
    storeWorkspaceSource('writer', 'paper', { fileId: 'chapter', mode: 'files' }, storage);
    storage.setItem([...values.keys()][0]!, value);
    expect(loadWorkspaceSource('writer', 'paper', storage)).toBeNull();
  });

  it('allows navigation when browser storage is blocked or full', () => {
    const blocked = {
      getItem: () => { throw new DOMException('Blocked', 'SecurityError'); },
      setItem: () => { throw new DOMException('Full', 'QuotaExceededError'); }
    };
    expect(loadWorkspaceSource('writer', 'paper', blocked)).toBeNull();
    expect(() => storeWorkspaceSource('writer', 'paper', { fileId: 'chapter', mode: 'files' }, blocked)).not.toThrow();
  });
});

describe('workspace layout persistence', () => {
  beforeEach(() => values.clear());

  it('remembers whether the file tree is open', () => {
    expect(loadTreeOpen(storage)).toBe(true);
    storeTreeOpen(false, storage);
    expect(loadTreeOpen(storage)).toBe(false);
  });

  it('remembers a valid editor split', () => {
    storeEditorPercent(63.25, storage);
    expect(loadEditorPercent(storage)).toBe(63.25);
  });

  it('ignores invalid editor splits', () => {
    storage.setItem('overroot.editorSplit', 'outside');
    expect(loadEditorPercent(storage)).toBe(50);
    storage.setItem('overroot.editorSplit', '90');
    expect(loadEditorPercent(storage)).toBe(50);
  });
});
