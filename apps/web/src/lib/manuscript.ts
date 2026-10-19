export interface ManuscriptSource { id: string; path: string; content: string }
export interface ManuscriptSpan {
  from: number;
  to: number;
  fileId: string;
  path: string;
  sourceFrom: number;
}
export interface Manuscript {
  text: string;
  spans: ManuscriptSpan[];
  warnings: string[];
}

// This is a source navigator, not a TeX interpreter. Only literal braced inputs
// are expanded. Keep unsupported commands in the source for the compiler.
export function buildManuscript(entry: string, sources: ManuscriptSource[]): Manuscript {
  const files = new Map(sources.map((file) => [file.path, file]));
  const result: Manuscript = { text: '', spans: [], warnings: [] };
  const seen = new Set<string>();
  let expansions = 0;
  const marker = (label: string) => { result.text += `\n% ── ${label} ──\n`; };
  const visit = (path: string, depth: number) => {
    const file = files.get(path);
    if (!file || seen.has(path) || depth > 32 || ++expansions > 500) {
      result.warnings.push(`Could not expand ${path}: missing file, repeated input, or nesting limit. Use Files to inspect it.`);
      marker(`Unexpanded: ${path}`);
      return;
    }
    seen.add(path);
    marker(path);
    const append = (from: number, to: number) => {
      const start = result.text.length;
      result.text += file.content.slice(from, to);
      result.spans.push({ from: start, to: result.text.length, fileId: file.id, path, sourceFrom: from });
    };
    const masked = maskNonCode(file.content);
    const inputs = /\\(input|include)\s*\{([^{}]*)\}/g;
    let offset = 0;
    let scanned = 0;
    let braces = 0;
    for (const match of masked.matchAll(inputs)) {
      // Inputs inside macro arguments/definitions are not necessarily executed
      // here. Leave those to TeX rather than inventing a document order.
      while (scanned < match.index) {
        if (masked[scanned] === '\\') { scanned += 2; continue; }
        if (masked[scanned] === '{') braces++;
        if (masked[scanned] === '}') braces--;
        scanned++;
      }
      if (braces !== 0) continue;
      const name = match[2]!.trim();
      if (!name || /[\\#$%]/.test(name)) continue;
      const target = normalizeInput(name.endsWith('.tex') ? name : `${name}.tex`);
      append(offset, match.index);
      // Preserve the actual directive in a protected region of the projection.
      result.text += file.content.slice(match.index, match.index + match[0].length);
      visit(target, depth + 1);
      marker(`Continue ${path}`);
      offset = match.index + match[0].length;
    }
    append(offset, file.content.length);
  };
  visit(entry, 0);
  return result;
}

function normalizeInput(path: string): string {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '..') parts.pop();
    else if (part !== '.' && part) parts.push(part);
  }
  return parts.join('/');
}

function maskNonCode(content: string): string {
  // Preserve offsets while ignoring comments, verbatim environments and \verb.
  return content.replace(/\\begin\{(verbatim\*?|lstlisting|minted|comment)\}[\s\S]*?\\end\{\1\}|\\verb\*?([^\w\s])[\s\S]*?\2|\\.|%[^\n]*/g, (match) =>
    match.startsWith('\\begin') || match.startsWith('\\verb') || match.startsWith('%') || match === '\\\\'
      ? match.replace(/[^\n]/g, ' ')
      : match);
}

export function sourceSpan(manuscript: Manuscript, from: number, to = from): ManuscriptSpan | undefined {
  return manuscript.spans.find((span) => from >= span.from && to <= span.to);
}

export function sourceLocation(manuscript: Manuscript, position: number, sources: ManuscriptSource[]) {
  const span = sourceSpan(manuscript, position);
  if (!span) return null;
  const source = sources.find((file) => file.id === span.fileId)!;
  const offset = span.sourceFrom + position - span.from;
  return { path: span.path, line: source.content.slice(0, offset).split('\n').length };
}
