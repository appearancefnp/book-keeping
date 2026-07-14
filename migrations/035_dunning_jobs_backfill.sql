-- Seed one dunning_run job for every client that already has dunning enabled, so existing
-- tenants start on the queue without manual action. Deduped on today's date; the handler
-- chains subsequent days. Runs as admin (RLS FORCE does not apply to a plain admin INSERT here
-- because admin is the table owner and this migration is trusted setup).
INSERT INTO jobs (client_company_id, firm_id, type, run_at, payload, dedup_key)
SELECT c.id, c.firm_id, 'dunning_run', now(),
       jsonb_build_object('asOf', now()::date::text),
       'dunning:' || now()::date::text
  FROM client_companies c
  JOIN dunning_policy p ON p.client_company_id = c.id
 WHERE p.enabled = true
ON CONFLICT (client_company_id, type, dedup_key) WHERE dedup_key IS NOT NULL DO NOTHING;
-- NOTE: the WHERE predicate is REQUIRED — jobs_dedup_idx is a partial unique index
-- (WHERE dedup_key IS NOT NULL), so ON CONFLICT inference must repeat that predicate.
