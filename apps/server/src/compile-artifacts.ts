import { open } from 'node:fs/promises';

export async function hasPdfSignature(path: string): Promise<boolean> {
  const file = await open(path, 'r');
  try {
    const signature = Buffer.alloc(5);
    let offset = 0;
    while (offset < signature.length) {
      const { bytesRead } = await file.read(signature, offset, signature.length - offset, offset);
      if (!bytesRead) return false;
      offset += bytesRead;
    }
    return signature.toString('utf8') === '%PDF-';
  } finally {
    await file.close();
  }
}
