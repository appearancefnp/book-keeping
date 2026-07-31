-- M9 slice B: per-client VAT registration + filing periodicity, and the ECSL proposal type.
CREATE TABLE vat_settings (
  client_company_id uuid PRIMARY KEY REFERENCES client_companies(id),
  vat_no text,
  periodicity text NOT NULL DEFAULT 'monthly' CHECK (periodicity IN ('monthly','quarterly')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE vat_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE vat_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY vat_settings_tenant_isolation ON vat_settings
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON vat_settings TO bookkeeping_app;

-- The EC Sales List is prepared as an approval-gated proposal, like the VAT declaration.
ALTER TABLE proposals DROP CONSTRAINT proposals_type_check;
ALTER TABLE proposals ADD CONSTRAINT proposals_type_check
  CHECK (type IN ('posting','bank_match','declaration','task','recurring_invoice','ecsl'));
