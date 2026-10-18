import { beforeEach, describe, expect, it } from 'vitest';
import {
  loadEditorPercent, loadTreeOpen, storeEditorPercent, storeTreeOpen
} from './workspace-state';

const values = new Map<string, string>();
const storage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => { values.set(key, value); }
};

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
