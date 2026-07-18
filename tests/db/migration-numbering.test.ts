import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { expect, test } from 'vitest';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../migrations');

// Applied migrations are recorded by full filename and ordered lexicographically,
// so these historical prefix collisions are stable — but NEW collisions create
// confusing, order-sensitive numbering. Never add to this set; take max+1 instead.
const GRANDFATHERED_DUPLICATE_PREFIXES = new Set(['023', '024', '025', '026']);

test('every migration filename is NNN_snake_case.sql', () => {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
  expect(files.length).toBeGreaterThan(0);
  for (const f of files) {
    expect(f, `malformed migration filename: ${f}`).toMatch(/^\d{3}_[a-z0-9_]+\.sql$/);
  }
});

test('no NEW duplicate migration number prefixes beyond the grandfathered set', () => {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
  const byPrefix = new Map<string, string[]>();
  for (const f of files) {
    const prefix = f.slice(0, 3);
    byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), f]);
  }
  const offenders = [...byPrefix.entries()]
    .filter(([prefix, names]) => names.length > 1 && !GRANDFATHERED_DUPLICATE_PREFIXES.has(prefix));
  expect(offenders, `duplicate migration numbers: ${JSON.stringify(offenders)} — use max+1 across ALL files`).toEqual([]);
});
