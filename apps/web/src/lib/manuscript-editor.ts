import { Annotation, EditorState, type Extension, type Transaction } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import * as Y from 'yjs';
import { buildManuscript, sourceLocation, sourceSpan, type ManuscriptSource } from './manuscript';
import type { SourceLocation } from '../types';

const localOrigin = Symbol('manuscript edit');
const refreshAnnotation = Annotation.define<boolean>();
export interface ManuscriptDocument { id: string; path: string; doc: Y.Doc }

/** A projection only: every accepted edit changes one original Y.Text. */
export class ManuscriptEditor {
  readonly view: EditorView;
  private projection;
  private managers = new Map<string, Y.UndoManager>();
  private undoFiles: string[] = [];
  private redoFiles: string[] = [];
  private destroyed = false;
  private updating = false;
  private queued = false;
  private selection: Array<{ id: string; position: Y.RelativePosition } | null> = [];

  constructor(
    parent: HTMLElement,
    private entry: string,
    private documents: ManuscriptDocument[],
    extensions: Extension[],
    private canEdit: (id: string) => boolean,
    private onCursor: (location: SourceLocation | null) => void,
    private onNotice: (notice: string, warnings: string[]) => void
  ) {
    this.projection = buildManuscript(entry, this.sources());
    for (const file of documents) {
      this.managers.set(file.id, new Y.UndoManager(file.doc.getText('content'), { trackedOrigins: new Set([localOrigin]), captureTimeout: 0 }));
      file.doc.on('update', this.scheduleRefresh);
    }
    this.view = new EditorView({
      parent,
      state: EditorState.create({ doc: this.projection.text, extensions: [
        EditorState.lineSeparator.of('\n'),
        keymap.of([
          { key: 'Mod-z', run: () => this.undo(), preventDefault: true },
          { key: 'Mod-Shift-z', run: () => this.redo(), preventDefault: true },
          { key: 'Mod-y', run: () => this.redo(), preventDefault: true }
        ]),
        ...extensions,
        EditorState.transactionFilter.of((transaction) => {
          if (!transaction.docChanged || transaction.annotation(refreshAnnotation)) return transaction;
          let valid = true;
          const owners = new Set<string>();
          transaction.changes.iterChanges((from, to) => {
            const span = sourceSpan(this.projection, from, to);
            if (!span || !this.canEdit(span.fileId)) valid = false;
            else owners.add(span.fileId);
          });
          if (valid && owners.size === 1) return transaction;
          this.onNotice('Edit within one section at a time. Include lines and file boundaries are protected; use Files to change them.', this.projection.warnings);
          return [];
        })
      ] }),
      dispatchTransactions: (transactions) => this.dispatch(transactions)
    });
    this.onNotice('', this.projection.warnings);
  }

  private sources(): ManuscriptSource[] {
    return this.documents.map((file) => ({ id: file.id, path: file.path, content: file.doc.getText('content').toString() }));
  }

  private dispatch(transactions: readonly Transaction[]) {
    this.updating = true;
    try {
      // EditorView normally receives one transaction; process sequentially so
      // each change is mapped against its own starting projection.
      for (const transaction of transactions) {
        const projection = this.projection;
        this.view.update([transaction]);
        if (transaction.docChanged && !transaction.annotation(refreshAnnotation)) {
          const edits: Array<{ id: string; from: number; to: number; insert: string }> = [];
          transaction.changes.iterChanges((from, to, _fromB, _toB, inserted) => {
            const span = sourceSpan(projection, from, to)!;
            edits.push({ id: span.fileId, from: span.sourceFrom + from - span.from, to: span.sourceFrom + to - span.from, insert: inserted.toString() });
          });
          const id = edits[0]!.id;
          const doc = this.documents.find((file) => file.id === id)!.doc;
          doc.transact(() => {
            const text = doc.getText('content');
            for (const edit of edits.reverse()) {
              text.delete(edit.from, edit.to - edit.from);
              text.insert(edit.from, edit.insert);
            }
          }, localOrigin);
          this.undoFiles.push(id);
          this.redoFiles = [];
          this.refresh();
        }
      }
    } finally { this.updating = false; }
    this.reportCursor();
  }

  private scheduleRefresh = () => {
    if (this.queued || this.destroyed) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      if (!this.destroyed) this.refresh();
    });
  };

  refresh() {
    const next = buildManuscript(this.entry, this.sources());
    const previous = this.view.state.doc.toString();
    this.projection = next;
    if (previous !== next.text) {
      // A small replacement preserves selection and scroll for remote edits.
      let from = 0;
      while (from < previous.length && from < next.text.length && previous[from] === next.text[from]) from++;
      let endA = previous.length;
      let endB = next.text.length;
      while (endA > from && endB > from && previous[endA - 1] === next.text[endB - 1]) { endA--; endB--; }
      const positions = this.updating ? [] : this.selection.map((point) => {
        if (!point) return undefined;
        const file = this.documents.find((file) => file.id === point.id)!;
        const absolute = Y.createAbsolutePositionFromRelativePosition(point.position, file.doc);
        if (!absolute) return undefined;
        const span = next.spans.find((candidate) => candidate.fileId === point.id && absolute.index >= candidate.sourceFrom && absolute.index <= candidate.sourceFrom + candidate.to - candidate.from);
        return span ? span.from + absolute.index - span.sourceFrom : undefined;
      });
      const selection = positions.length === 2 && positions[0] != null && positions[1] != null ? { anchor: positions[0], head: positions[1] } : undefined;
      const transaction = this.view.state.update({ changes: { from, to: endA, insert: next.text.slice(from, endB) }, selection, annotations: refreshAnnotation.of(true), filter: false });
      if (this.updating) this.view.update([transaction]);
      else this.view.dispatch(transaction);
    }
    this.onNotice('', next.warnings);
    this.reportCursor();
  }

  private reportCursor() {
    this.selection = [this.view.state.selection.main.anchor, this.view.state.selection.main.head].map((position) => {
      const span = sourceSpan(this.projection, position);
      if (!span) return null;
      const file = this.documents.find((file) => file.id === span.fileId)!;
      return { id: span.fileId, position: Y.createRelativePositionFromTypeIndex(file.doc.getText('content'), span.sourceFrom + position - span.from) };
    });
    this.onCursor(sourceLocation(this.projection, this.view.state.selection.main.head, this.sources()));
  }

  undo(): boolean { return this.moveHistory(this.undoFiles, this.redoFiles, false); }
  redo(): boolean { return this.moveHistory(this.redoFiles, this.undoFiles, true); }
  private moveHistory(from: string[], to: string[], redo: boolean) {
    if (from.length) {
      const id = from.pop()!;
      if (!this.canEdit(id)) { from.push(id); return true; }
      const manager = this.managers.get(id)!;
      if (redo ? manager.redo() : manager.undo()) { to.push(id); this.refresh(); return true; }
      this.onNotice('That edit was replaced by a newer change. No other file was changed.', this.projection.warnings);
    }
    return true;
  }

  destroy() {
    this.destroyed = true;
    for (const file of this.documents) file.doc.off('update', this.scheduleRefresh);
    for (const manager of this.managers.values()) manager.destroy();
    this.view.destroy();
  }
}
