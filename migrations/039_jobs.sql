-- Durable job queue (M4 slice C-infra). Control-plane infra table, NOT ordinary tenant data:
-- tenant code enqueues/reads its own rows under the standard tenant-isolation policy, while a
-- dedicated least-privilege bookkeeping_worker role claims across all tenants via USING(true).
-- Runs as admin inside one transaction (CREATE ROLE is transactional in Postgres).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bookkeeping_worker') THEN
    CREATE ROLE bookkeeping_worker LOGIN PASSWORD 'worker_pw';
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO bookkeeping_worker;

CREATE TABLE jobs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  firm_id           uuid NOT NULL REFERENCES firms(id),
  type              text NOT NULL,
  status            text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','running','done','failed')),
  run_at            timestamptz NOT NULL,
  payload           jsonb NOT NULL DEFAULT '{}',
  dedup_key         text,
  attempts          int  NOT NULL DEFAULT 0,
  max_attempts      int  NOT NULL DEFAULT 5,
  last_error        text,
  claimed_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX jobs_dedup_idx
  ON jobs(client_company_id, type, dedup_key) WHERE dedup_key IS NOT NULL;

CREATE INDEX jobs_claim_idx ON jobs(status, run_at) WHERE status IN ('pending','running');

ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs FORCE ROW LEVEL SECURITY;

CREATE POLICY jobs_tenant_isolation ON jobs TO bookkeeping_app
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);

CREATE POLICY jobs_worker_all ON jobs TO bookkeeping_worker
  USING (true) WITH CHECK (true);

GRANT SELECT, INSERT ON jobs TO bookkeeping_app;
GRANT SELECT, UPDATE ON jobs TO bookkeeping_worker;
