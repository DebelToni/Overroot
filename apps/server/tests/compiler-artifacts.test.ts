import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { hasPdfEnvelope, hasPdfSignature } from '../src/compile-artifacts.js';

const control = vi.hoisted(() => ({
  read: null as ((position: number) => Promise<void>) | null,
  reads: [] as Array<{ offset: number; length: number; position: number }>,
  bytesRead: 0,
  closes: 0
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args);
    return {
      read: async (buffer: Buffer, offset: number, length: number, position: number) => {
        control.reads.push({ offset, length, position });
        await control.read?.(position);
        // Exercise legal short reads too.
        const result = await handle.read(buffer, offset, Math.min(length, 2), position);
        control.bytesRead += result.bytesRead;
        return result;
      },
      stat: () => handle.stat(),
      close: async () => { control.closes++; await handle.close(); }
    };
  } };
});

let dir: string;
afterEach(async () => {
  control.read = null;
  control.reads.length = 0;
  control.bytesRead = 0;
  control.closes = 0;
  if (dir) await rm(dir, { recursive: true, force: true });
});

it.each(['', '%PD', '%PDX-', 'not a PDF', Buffer.from([0xa5, 0x50, 0x44, 0x46, 0x2d])])('rejects invalid or truncated signature %j', async content => {
  dir = await mkdtemp(join(tmpdir(), 'overroot-pdf-'));
  const path = join(dir, 'invalid.pdf');
  await writeFile(path, content);
  expect(await hasPdfSignature(path)).toBe(false);
  expect(control.closes).toBe(1);
});

it('reads at most the five signature bytes from a large PDF and closes its handle', async () => {
  dir = await mkdtemp(join(tmpdir(), 'overroot-pdf-'));
  const path = join(dir, 'valid.pdf');
  await writeFile(path, Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(1024 * 1024)]));
  expect(await hasPdfSignature(path)).toBe(true);
  expect(control.reads).toEqual([
    { offset: 0, length: 5, position: 0 },
    { offset: 2, length: 3, position: 2 },
    { offset: 4, length: 1, position: 4 }
  ]);
  expect(control.closes).toBe(1);
});

it('closes the PDF handle if reading fails', async () => {
  dir = await mkdtemp(join(tmpdir(), 'overroot-pdf-'));
  const path = join(dir, 'failure.pdf');
  await writeFile(path, '%PDF-1.7');
  control.read = async () => { throw new Error('Controlled read failure'); };
  await expect(hasPdfSignature(path)).rejects.toThrow('Controlled read failure');
  expect(control.closes).toBe(1);
});

it.each(['%PDF-1.7\ntruncated', '%PDF-1.7\n%%EO', '%PDF-1.7\n%%EOF\ntrailing', 'not PDF\n%%EOF\n'])(
  'rejects an incomplete compiler artifact %j', async content => {
    dir = await mkdtemp(join(tmpdir(), 'overroot-pdf-'));
    const path = join(dir, 'incomplete.pdf');
    await writeFile(path, content);
    expect(await hasPdfEnvelope(path)).toBe(false);
    expect(control.closes).toBe(1);
  }
);

it.each(['\n', '\r\n', '\n \t\f\r\n', '\n\0'])('accepts a terminal compiler PDF marker followed by %j', async whitespace => {
  dir = await mkdtemp(join(tmpdir(), 'overroot-pdf-'));
  const path = join(dir, 'envelope.pdf');
  await writeFile(path, `%PDF-1.7\ntrailer\n<< /Size 1 >>\nstartxref\n9\n%%EOF${whitespace}`);
  expect(await hasPdfEnvelope(path)).toBe(true);
  expect(control.closes).toBe(1);
});

it('checks only five header bytes and at most 1024 tail bytes even with short reads', async () => {
  dir = await mkdtemp(join(tmpdir(), 'overroot-pdf-'));
  const path = join(dir, 'large.pdf');
  await writeFile(path, Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(1024 * 1024), Buffer.from('\nstartxref\n9\n%%EOF\n')]));
  expect(await hasPdfEnvelope(path)).toBe(true);
  expect(control.bytesRead).toBe(5 + 1024);
  expect(control.closes).toBe(1);
});

it('closes the PDF handle if reading the footer fails after a valid header', async () => {
  dir = await mkdtemp(join(tmpdir(), 'overroot-pdf-'));
  const path = join(dir, 'footer-failure.pdf');
  await writeFile(path, '%PDF-1.7\nstartxref\n9\n%%EOF\n');
  control.read = async position => { if (position >= 5) throw new Error('Controlled footer read failure'); };
  await expect(hasPdfEnvelope(path)).rejects.toThrow('Controlled footer read failure');
  expect(control.bytesRead).toBe(5);
  expect(control.closes).toBe(1);
});
