import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

/**
 * Object storage abstraction. Files are NEVER served from a public URL: they are only read back through authorised API
 * endpoints. Swap LocalDiskStorage for an S3/GCS implementation in deployment without touching callers.
 */
export interface ObjectStorage {
  put(buf: Buffer): Promise<{ key: string; sha256: string }>;
  get(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
}
export const OBJECT_STORAGE = Symbol('OBJECT_STORAGE');

@Injectable()
export class LocalDiskStorage implements ObjectStorage {
  private readonly base = resolve(process.env.STORAGE_DIR ?? './uploads');

  /** Keys are generated here (never from user input) and re-checked to stay inside the base directory. */
  private path(key: string): string {
    const p = resolve(this.base, key);
    if (!p.startsWith(this.base + sep)) throw new Error('Invalid storage key');
    return p;
  }

  async put(buf: Buffer) {
    const key = `${new Date().toISOString().slice(0, 7)}/${randomUUID()}`;
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, buf, { flag: 'wx' });
    return { key, sha256: createHash('sha256').update(buf).digest('hex') };
  }

  get(key: string) {
    return readFile(this.path(key));
  }

  async remove(key: string) {
    await rm(this.path(key), { force: true });
  }
}

/** Identifies allowed attachment types from the file's own bytes; the client-declared type is ignored. */
export function sniffType(buf: Buffer): { contentType: string; ext: string } | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { contentType: 'image/png', ext: 'png' };
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { contentType: 'image/jpeg', ext: 'jpg' };
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return { contentType: 'application/pdf', ext: 'pdf' };
  return null;
}

/** Safe display name: no path parts or control characters, bounded length. */
export function safeFileName(name: string, ext: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[^\p{L}\p{N}._ -]/gu, '_').replace(/^\.+/, '').slice(0, 80).trim();
  const stem = cleaned.replace(/\.[A-Za-z0-9]{1,5}$/, '') || 'attachment';
  return `${stem}.${ext}`;
}
