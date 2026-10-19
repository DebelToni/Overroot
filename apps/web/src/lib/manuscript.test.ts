import { describe, expect, it } from 'vitest';
import { buildManuscript, sourceLocation, sourceSpan } from './manuscript';

const file = (path: string, content: string) => ({ id: path, path, content });

describe('manuscript source projection', () => {
  it('expands nested inputs in document order and maps edits to original offsets', () => {
    const sources = [file('main.tex', 'Before\\input{sections/intro}After'), file('sections/intro.tex', 'Intro\n\\include{results}Done'), file('results.tex', 'Results')];
    const manuscript = buildManuscript('main.tex', sources);
    expect(manuscript.warnings).toEqual([]);
    expect(manuscript.text.indexOf('Before')).toBeLessThan(manuscript.text.indexOf('Intro'));
    expect(manuscript.text.indexOf('Intro')).toBeLessThan(manuscript.text.indexOf('Results'));
    expect(manuscript.text.indexOf('Results')).toBeLessThan(manuscript.text.indexOf('After'));
    const after = manuscript.text.indexOf('After');
    const span = sourceSpan(manuscript, after, after + 5)!;
    expect(span.fileId).toBe('main.tex');
    expect(span.sourceFrom + after - span.from).toBe(sources[0]!.content.indexOf('After'));
    expect(sourceLocation(manuscript, manuscript.text.indexOf('Done'), sources)).toEqual({ path: 'sections/intro.tex', line: 2 });
  });

  it('protects include directives and rejects cross-module edits', () => {
    const manuscript = buildManuscript('main.tex', [file('main.tex', 'A\\input{body}Z'), file('body.tex', 'Body')]);
    expect(sourceSpan(manuscript, manuscript.text.indexOf('\\input') + 1)).toBeUndefined();
    expect(sourceSpan(manuscript, manuscript.text.indexOf('A'), manuscript.text.indexOf('Body') + 2)).toBeUndefined();
  });

  it('ignores comments, escaped commands and verbatim examples', () => {
    const content = '% \\input{missing}\n\\\\input{missing}\n\\verb|\\input{missing}|\n\\begin{verbatim}\\input{missing}\\end{verbatim}\n\\input{body}';
    const manuscript = buildManuscript('main.tex', [file('main.tex', content), file('body.tex', 'Actual body')]);
    expect(manuscript.warnings).toEqual([]);
    expect(manuscript.text).toContain('Actual body');
  });

  it('leaves dynamic inputs intact and bounds missing, repeated and cyclic inputs', () => {
    const manuscript = buildManuscript('main.tex', [file('main.tex', '\\input{\\dynamic}\\input{missing}\\input{body}\\input{body}'), file('body.tex', '\\input{main}')]);
    expect(manuscript.text).toContain('\\input{\\dynamic}');
    expect(manuscript.warnings).toHaveLength(3);
  });

  it('keeps an empty file editable and resolves paths from the compilation root', () => {
    const manuscript = buildManuscript('main.tex', [file('main.tex', '\\input{./sections/../empty.tex}'), file('empty.tex', '')]);
    expect(manuscript.warnings).toEqual([]);
    expect(manuscript.spans.some((span) => span.fileId === 'empty.tex' && span.from === span.to)).toBe(true);
  });

  it('never maps absolute or above-root inputs into unrelated project files', () => {
    for (const input of ['../body', '/body', 'C:/body']) {
      const manuscript = buildManuscript('main.tex', [file('main.tex', `\\input{${input}}`), file('body.tex', 'Unrelated body')]);
      expect(manuscript.text).not.toContain('Unrelated body');
      expect(manuscript.warnings).toHaveLength(1);
    }
  });
});
