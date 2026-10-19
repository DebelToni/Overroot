import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { ManuscriptEditor } from './manuscript-editor';

const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).reverse().forEach((dispose) => dispose()); });
function setup(canEdit = true) {
  const main = new Y.Doc();
  const body = new Y.Doc();
  main.getText('content').insert(0, 'Before\n\\input{body}\nAfter');
  body.getText('content').insert(0, 'Body text');
  const parent = document.createElement('div'); document.body.append(parent);
  let notice = '';
  let location: unknown;
  const editor = new ManuscriptEditor(parent, 'main.tex', [
    { id: 'main', path: 'main.tex', doc: main }, { id: 'body', path: 'body.tex', doc: body }
  ], [], () => canEdit, (value) => { location = value; }, (value) => { notice = value; });
  cleanup.push(() => { editor.destroy(); main.destroy(); body.destroy(); parent.remove(); });
  return { editor, main, body, notice: () => notice, location: () => location };
}

describe('editable manuscript backed by modular Yjs files', () => {
  it('saves a body edit only into the body module and preserves main bytes', () => {
    const { editor, main, body, location } = setup();
    const original = main.getText('content').toString();
    const from = editor.view.state.doc.toString().indexOf('Body text');
    editor.view.dispatch({ changes: { from, to: from + 4, insert: 'New' }, selection: { anchor: from + 3 } });
    expect(body.getText('content').toString()).toBe('New text');
    expect(main.getText('content').toString()).toBe(original);
    expect(location()).toEqual({ path: 'body.tex', line: 1 });
  });

  it('maps edits after an expanded input to their original main-file offsets', () => {
    const { editor, main, body } = setup();
    const from = editor.view.state.doc.toString().indexOf('After');
    editor.view.dispatch({ changes: { from, to: from + 5, insert: 'Ending' } });
    expect(main.getText('content').toString()).toBe('Before\n\\input{body}\nEnding');
    expect(body.getText('content').toString()).toBe('Body text');
  });

  it('blocks cross-file selection replacement and edits to include boundaries', () => {
    const { editor, main, body, notice } = setup();
    const original = editor.view.state.doc.toString();
    editor.view.dispatch({ changes: { from: original.indexOf('Before'), to: original.indexOf('After') + 5, insert: 'Oops' } });
    expect(editor.view.state.doc.toString()).toBe(original);
    expect(notice()).toContain('one section');
    const input = original.indexOf('\\input');
    editor.view.dispatch({ changes: { from: input, to: input + 6, insert: '' } });
    expect(main.getText('content').toString()).toContain('\\input{body}');
    expect(body.getText('content').toString()).toBe('Body text');
  });

  it('supports chronological undo across files without undoing agent changes', async () => {
    const { editor, main, body } = setup();
    editor.view.dispatch({ changes: { from: editor.view.state.doc.toString().indexOf('Body text'), insert: 'Human ' } });
    body.transact(() => body.getText('content').insert(body.getText('content').length, ' agent'), Symbol('remote'));
    await Promise.resolve();
    editor.view.dispatch({ changes: { from: editor.view.state.doc.toString().indexOf('After'), insert: 'Last ' } });
    editor.undo(); editor.undo();
    expect(main.getText('content').toString()).toBe('Before\n\\input{body}\nAfter');
    expect(body.getText('content').toString()).toBe('Body text agent');
    editor.redo(); editor.redo();
    expect(body.getText('content').toString()).toBe('Human Body text agent');
    expect(main.getText('content').toString()).toContain('Last After');
  });

  it('updates the continuous view when another client edits a module', async () => {
    const { editor, body } = setup();
    const agent = new Y.Doc(); Y.applyUpdate(agent, Y.encodeStateAsUpdate(body));
    agent.getText('content').insert(0, 'Agent ');
    Y.applyUpdate(body, Y.encodeStateAsUpdate(agent));
    await Promise.resolve();
    expect(editor.view.state.doc.toString()).toContain('Agent Body text');
    agent.destroy();
  });

  it('rejects writes and undo when read-only or disconnected', () => {
    const { editor, body } = setup(false);
    editor.view.dispatch({ changes: { from: editor.view.state.doc.toString().indexOf('Body text'), insert: 'Oops' } });
    editor.undo();
    expect(body.getText('content').toString()).toBe('Body text');
  });

  it('preserves a body cursor when remote main edits surround that module', async () => {
    const { editor, main } = setup();
    const position = editor.view.state.doc.toString().indexOf('Body text') + 4;
    editor.view.dispatch({ selection: { anchor: position } });
    main.transact(() => {
      main.getText('content').insert(main.getText('content').length, ' new ending');
      main.getText('content').insert(0, 'New beginning ');
    }, Symbol('remote'));
    await Promise.resolve();
    expect(editor.view.state.selection.main.head).toBe(editor.view.state.doc.toString().indexOf('Body text') + 4);
  });

  it('preserves CRLF bytes and source offsets when editing after a Windows newline', async () => {
    const { editor, body, main } = setup();
    body.transact(() => {
      body.getText('content').delete(0, body.getText('content').length);
      body.getText('content').insert(0, 'First\r\nSecond\r\n');
    }, Symbol('remote'));
    await Promise.resolve();
    const from = editor.view.state.doc.toString().indexOf('Second');
    editor.view.dispatch({ changes: { from, to: from + 6, insert: 'Changed' } });
    expect(body.getText('content').toString()).toBe('First\r\nChanged\r\n');
    expect(main.getText('content').toString()).toBe('Before\n\\input{body}\nAfter');
  });
});
