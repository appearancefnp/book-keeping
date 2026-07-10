-- Per-client invoice defaults (G4 slice 3a). Tenant data → RLS-enabled like accounts.
CREATE TABLE invoice_profiles (
  client_company_id     uuid PRIMARY KEY REFERENCES client_companies(id),
  payment_terms         text,
  note                  text,
  due_date_offset_days  integer,
  number_prefix         text,
  default_lines         jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            uuid
);

ALTER TABLE invoice_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY invoice_profiles_tenant_isolation ON invoice_profiles
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON invoice_profiles TO bookkeeping_app;
