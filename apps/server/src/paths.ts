import { posix } from 'node:path';

const MAX_PATH_LENGTH = 240;

export function normalizeProjectPath(input: string): string {
  const value = input.trim().replaceAll('\\', '/');
  if (!value || value.length > MAX_PATH_LENGTH || value.includes('\0') || value.startsWith('/')) {
    throw new Error('Invalid project path');
  }
  const normalized = posix.normalize(value).replace(/^\.\//, '');
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new Error('Invalid project path');
  }
  const parts = normalized.split('/');
  if (
    parts.some((part) => !part || part === '.' || part === '..' || part.startsWith('-') || part.length > 100) ||
    parts[0] === '.overroot-output'
  ) {
    throw new Error('Invalid project path');
  }
  return normalized;
}

export function isTextMime(mimeType: string, path: string): boolean {
  return (
    mimeType.startsWith('text/') ||
    /\.(tex|bib|sty|cls|txt|md|csv|json|yaml|yml|xml|svg|tikz)$/i.test(path)
  );
}
