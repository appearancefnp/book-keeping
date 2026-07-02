import { adminPool, appPool } from '../../src/db/pool.js';
import { runMigrations } from '../../src/db/migrate.js';

/** Wipe the public schema (as admin, to also drop the migrations table cleanly) and re-run migrations. */
export async function resetDb(): Promise<void> {
  await adminPool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await runMigrations();
}

export async function closeDb(): Promise<void> {
  await Promise.all([adminPool.end(), appPool.end()]);
}
