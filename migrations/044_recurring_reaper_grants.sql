-- reapRecurring (M4 C-recurring) revives a terminal-failed recurring_generate job in place
-- (UPDATE status back to 'pending') rather than skip-and-wait-for-rollover like dunning does,
-- because the recurring dedup key is period-based and stays identical across reap sweeps until
-- generateDueRecurring actually advances the template (unlike dunning's date-based key, which
-- rolls over daily). That requires an UPDATE grant on jobs for the supervisor role; it already has
-- the jobs_supervisor_all USING(true)/WITH CHECK(true) RLS policy from migration 036, so this only
-- adds the missing command-level privilege.
GRANT UPDATE ON jobs TO bookkeeping_supervisor;
