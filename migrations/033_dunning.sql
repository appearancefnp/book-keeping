-- AR dunning: per-client reminder policy + escalation stages + reminder history (M4 slice B).
CREATE TABLE dunning_policy (
  client_company_id uuid PRIMARY KEY REFERENCES client_companies(id),
  enabled boolean NOT NULL DEFAULT true,
  late_fee_annual_bps int NOT NULL DEFAULT 0,
  late_fee_flat_cents bigint NOT NULL DEFAULT 0
);

CREATE TABLE dunning_stages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  level int NOT NULL,
  days_overdue int NOT NULL,
  UNIQUE (client_company_id, level)
);
CREATE INDEX dunning_stages_client_idx ON dunning_stages(client_company_id);

CREATE TABLE dunning_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  einvoice_id uuid NOT NULL REFERENCES einvoices(id),
  level int NOT NULL,
  accrued_fee_cents bigint NOT NULL,
  task_id uuid REFERENCES tasks(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_company_id, einvoice_id, level)
);
CREATE INDEX dunning_events_einvoice_idx ON dunning_events(einvoice_id);

ALTER TABLE dunning_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE dunning_policy FORCE ROW LEVEL SECURITY;
CREATE POLICY dunning_policy_tenant_isolation ON dunning_policy
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON dunning_policy TO bookkeeping_app;

ALTER TABLE dunning_stages ENABLE ROW LEVEL SECURITY;
ALTER TABLE dunning_stages FORCE ROW LEVEL SECURITY;
CREATE POLICY dunning_stages_tenant_isolation ON dunning_stages
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON dunning_stages TO bookkeeping_app;

ALTER TABLE dunning_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE dunning_events FORCE ROW LEVEL SECURITY;
CREATE POLICY dunning_events_tenant_isolation ON dunning_events
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON dunning_events TO bookkeeping_app;
