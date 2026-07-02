CREATE TABLE autonomy_policy (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  operation_type text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('auto','approval')),
  material_threshold_cents bigint NOT NULL DEFAULT 100000,
  UNIQUE (client_company_id, operation_type)
);

ALTER TABLE autonomy_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE autonomy_policy FORCE ROW LEVEL SECURITY;
CREATE POLICY autonomy_tenant_isolation ON autonomy_policy
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON autonomy_policy TO bookkeeping_app;
