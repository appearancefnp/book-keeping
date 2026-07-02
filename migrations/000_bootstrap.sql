-- Runs as admin. Creates the non-superuser app role that RLS applies to.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bookkeeping_app') THEN
    CREATE ROLE bookkeeping_app LOGIN PASSWORD 'app_pw';
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO bookkeeping_app;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";  -- gen_random_uuid()
