import { open, type FileHandle } from 'node:fs/promises';

const PDF_TAIL_BYTES = 1024;
const PDF_WHITESPACE = new Set([0, 9, 10, 12, 13, 32]);

export async function hasPdfSignature(path: string): Promise<boolean> {
  const file = await open(path, 'r');
  try {
    const signature = Buffer.alloc(5);
    return await readAt(file, signature, 0) && signature.toString('utf8') === '%PDF-';
  } finally {
    await file.close();
  }
}

// A bounded completeness check for compiler-generated artifacts. This rejects
// missing headers/terminal EOF markers, without claiming semantic PDF validation.
export async function hasPdfEnvelope(path: string): Promise<boolean> {
  const file = await open(path, 'r');
  try {
    const signature = Buffer.alloc(5);
    if (!await readAt(file, signature, 0) || signature.toString('utf8') !== '%PDF-') return false;
    const { size } = await file.stat();
    const tailPosition = Math.max(signature.length, size - PDF_TAIL_BYTES);
    if (size - tailPosition < 5) return false;
    const tail = Buffer.alloc(size - tailPosition);
    if (!await readAt(file, tail, tailPosition)) return false;
    let end = tail.length;
    while (end > 0 && PDF_WHITESPACE.has(tail[end - 1]!)) end--;
    const marker = end - 5;
    return marker >= 0 && tail.subarray(marker, end).toString('latin1') === '%%EOF' &&
      (marker === 0 || tail[marker - 1] === 10 || tail[marker - 1] === 13);
  } finally {
    await file.close();
  }
}

async function readAt(file: FileHandle, buffer: Buffer, position: number): Promise<boolean> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, position + offset);
    if (!bytesRead) return false;
    offset += bytesRead;
  }
  return true;
}
