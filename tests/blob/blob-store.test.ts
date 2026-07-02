import { afterAll, beforeAll, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalBlobStore } from '../../src/blob/blob-store.js';

let dir: string;
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'blob-')); });
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

test('put then get round-trips bytes and mime', async () => {
  const store = new LocalBlobStore(dir);
  await store.put('docs/a.jpg', Buffer.from('hello'), 'image/jpeg');
  const got = await store.get('docs/a.jpg');
  expect(got.bytes.toString()).toBe('hello');
  expect(got.mime).toBe('image/jpeg');
});

test('get throws for a missing key', async () => {
  const store = new LocalBlobStore(dir);
  await expect(store.get('nope/missing.pdf')).rejects.toThrow();
});
