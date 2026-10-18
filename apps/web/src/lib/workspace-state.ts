const TREE_OPEN_KEY = 'overroot.fileTreeOpen';
const EDITOR_PERCENT_KEY = 'overroot.editorSplit';
type StateStorage = Pick<Storage, 'getItem' | 'setItem'>;

export const MIN_EDITOR_PERCENT = 25;
export const MAX_EDITOR_PERCENT = 75;

export function loadTreeOpen(storage: StateStorage = window.localStorage): boolean {
  return storage.getItem(TREE_OPEN_KEY) !== 'false';
}

export function storeTreeOpen(open: boolean, storage: StateStorage = window.localStorage): void {
  storage.setItem(TREE_OPEN_KEY, String(open));
}

export function loadEditorPercent(storage: StateStorage = window.localStorage): number {
  const value = Number(storage.getItem(EDITOR_PERCENT_KEY) ?? 50);
  return Number.isFinite(value) && value >= MIN_EDITOR_PERCENT && value <= MAX_EDITOR_PERCENT ? value : 50;
}

export function storeEditorPercent(percent: number, storage: StateStorage = window.localStorage): void {
  storage.setItem(EDITOR_PERCENT_KEY, String(percent));
}
