/**
 * CLI entrypoints only. `package.json`'s scripts run under `--env-file-if-exists=.env`
 * (not `--env-file=.env`), which is correct for the container and CI — both supply these
 * variables another way — but it means a *local* invocation with no `.env` present starts
 * anyway, with `pg` falling back to libpq defaults (localhost:5432, OS user). For a
 * destructive command like `npm run seed` (`DROP SCHEMA public CASCADE`), that failure
 * mode is silent and aimed at whatever answers on 5432. Call this first in a CLI
 * entrypoint's main guard so a missing DSN fails loudly, naming the variable, instead of
 * quietly connecting somewhere unintended.
 */
export function requireEnv(names: string[]): void {
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length) {
    console.error(`Missing required environment variable(s): ${missing.join(', ')}`);
    process.exit(1);
  }
}
