-- Chain reaper supervisor role (M4 C-infra follow-up). Trusted control-plane role that runs the
-- periodic reap sweep: reads which drivers are active (dunning_policy), resolves firm_id
-- (client_companies), reads jobs to detect dead/missing chains, and seeds recovery jobs. Kept
-- separate from bookkeeping_worker (which only transitions job state) to preserve least privilege.
-- Runs as admin in one transaction (CREATE ROLE is transactional in Postgres).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bookkeeping_supervisor') THEN
    CREATE ROLE bookkeeping_supervisor LOGIN PASSWORD 'supervisor_pw';
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO bookkeeping_supervisor;

-- Read active drivers + resolve firm_id; read + seed jobs. No other business-table access.
GRANT SELECT ON dunning_policy TO bookkeeping_supervisor;
GRANT SELECT ON client_companies TO bookkeeping_supervisor;   -- no RLS on this table; GRANT suffices
GRANT SELECT, INSERT ON jobs TO bookkeeping_supervisor;

-- jobs has FORCE RLS with role-scoped policies (app/worker); add a control-plane policy for the
-- supervisor so it can read + seed across tenants.
CREATE POLICY jobs_supervisor_all ON jobs TO bookkeeping_supervisor
  USING (true) WITH CHECK (true);

-- dunning_policy has FORCE RLS. Its tenant-isolation policy has no TO clause (applies to all roles)
-- and evaluates to no rows when app.current_client_id is unset. Permissive policies are OR-combined,
-- so this supervisor policy re-opens cross-tenant read for the supervisor role only.
CREATE POLICY dunning_policy_supervisor_read ON dunning_policy TO bookkeeping_supervisor
  USING (true);
