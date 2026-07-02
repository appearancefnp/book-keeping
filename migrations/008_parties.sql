CREATE TABLE parties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  kind text NOT NULL CHECK (kind IN ('customer','vendor','both')),
  name text NOT NULL,
  reg_no text,
  vat_no text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_company_id, kind, reg_no)
);
CREATE INDEX parties_client_idx ON parties(client_company_id);

ALTER TABLE parties ENABLE ROW LEVEL SECURITY;
ALTER TABLE parties FORCE ROW LEVEL SECURITY;
CREATE POLICY parties_tenant_isolation ON parties
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON parties TO bookkeeping_app;
