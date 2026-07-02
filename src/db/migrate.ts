import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { adminPool } from './pool.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../migrations');

export async function runMigrations(): Promise<string[]> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];

  // Bootstrap (admin) must run first and is idempotent.
  const bootstrap = files.find((f) => f.startsWith('000_'));
  if (bootstrap) {
    await adminPool.query(await readFile(join(MIGRATIONS_DIR, bootstrap), 'utf8'));
    applied.push(bootstrap);
  }

  await adminPool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);

  for (const file of files) {
    if (file.startsWith('000_')) continue;
    const done = await adminPool.query('SELECT 1 FROM schema_migrations WHERE filename = $1', [file]);
    if (done.rowCount) continue;
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    const client = await adminPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      applied.push(file);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
  return applied;
}

// Allow `npm run migrate`
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runMigrations()
    .then((a) => { console.log('Applied:', a); return adminPool.end(); })
    .catch((e) => { console.error(e); process.exit(1); });
}
