import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface BlobStore {
  put(key: string, bytes: Buffer, mime: string): Promise<void>;
  get(key: string): Promise<{ bytes: Buffer; mime: string }>;
}

/** Filesystem-backed blob store for dev/test. Stores bytes at <base>/<key> and mime at <base>/<key>.mime. */
export class LocalBlobStore implements BlobStore {
  constructor(private readonly baseDir: string) {}

  private path(key: string): string {
    return join(this.baseDir, key);
  }

  async put(key: string, bytes: Buffer, mime: string): Promise<void> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, bytes);
    await writeFile(`${p}.mime`, mime, 'utf8');
  }

  async get(key: string): Promise<{ bytes: Buffer; mime: string }> {
    const p = this.path(key);
    const bytes = await readFile(p);
    const mime = await readFile(`${p}.mime`, 'utf8');
    return { bytes, mime };
  }
}
