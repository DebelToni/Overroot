const TREE_OPEN_KEY = 'overroot.fileTreeOpen';
const EDITOR_PERCENT_KEY = 'overroot.editorSplit';
type StateStorage = Pick<Storage, 'getItem' | 'setItem'>;

export interface WorkspaceSource {
  fileId: string;
  mode: 'manuscript' | 'files';
}

export function loadWorkspaceSource(userId: string, projectHash: string, storage?: StateStorage): WorkspaceSource | null {
  try {
    const value: unknown = JSON.parse((storage ?? window.localStorage).getItem(workspaceSourceKey(userId, projectHash)) ?? 'null');
    if (value && typeof value === 'object' && 'fileId' in value && typeof value.fileId === 'string' && value.fileId &&
      'mode' in value && (value.mode === 'manuscript' || value.mode === 'files')) {
      return { fileId: value.fileId, mode: value.mode };
    }
  } catch { /* Browser storage can be unavailable or contain invalid JSON. */ }
  return null;
}

export function storeWorkspaceSource(userId: string, projectHash: string, source: WorkspaceSource, storage?: StateStorage): void {
  try {
    (storage ?? window.localStorage).setItem(workspaceSourceKey(userId, projectHash), JSON.stringify(source));
  } catch { /* A blocked or full store must not prevent opening a file. */ }
}

function workspaceSourceKey(userId: string, projectHash: string): string {
  return `overroot.workspaceSource.${JSON.stringify([userId, projectHash])}`;
}

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
