import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function revisionHash(value: Uint8Array | string): string {
  return sha256(value);
}

export function fileRevision(path: string, content: Uint8Array | string): string {
  const hash = createHash('sha256');
  hash.update(path);
  hash.update('\0');
  hash.update(content);
  return hash.digest('hex');
}

export function randomToken(prefix: string, bytes = 32): string {
  return `${prefix}${randomBytes(bytes).toString('base64url')}`;
}

export function randomPublicId(): string {
  return `prj_${randomBytes(12).toString('base64url')}`;
}

export function safeEqualText(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
