import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { expect, test } from 'vitest';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../migrations');

// Applied migrations are recorded by full filename and ordered lexicographically,
// so these historical prefix collisions are stable — but NEW collisions create
// confusing, order-sensitive numbering. Never add to this map; take max+1 instead.
// Pinned to the exact known filenames so a THIRD file on a grandfathered prefix
// still trips the guard.
const GRANDFATHERED_DUPLICATES: Record<string, string[]> = {
  '023': ['023_client_tariffs.sql', '023_payroll_rules.sql'],
  '024': ['024_onboarding_templates.sql', '024_payroll_settings.sql'],
  '025': ['025_employees.sql', '025_invoice_profiles.sql'],
  '026': ['026_invoice_profile_branding.sql', '026_payroll_inputs.sql'],
};

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
  const offenders = [...byPrefix.entries()].filter(([prefix, names]) =>
    names.length > 1 &&
    JSON.stringify([...names].sort()) !== JSON.stringify(GRANDFATHERED_DUPLICATES[prefix] ?? []));
  expect(offenders, `duplicate migration numbers: ${JSON.stringify(offenders)} — use max+1 across ALL files`).toEqual([]);
});
