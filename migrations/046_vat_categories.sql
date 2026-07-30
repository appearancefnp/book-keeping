-- M9 slice A: EN 16931 VAT categories on document lines.
-- Sales documents had no line rows at all (einvoices stored only ubl_xml + totals), so the
-- sales side gets a real line table here. cn_code / net_mass_kg are Intrastat (slice C) and
-- are deliberately unused by slice A+B — they land now so slice C needs no migration on
-- these hot tables.

CREATE TABLE einvoice_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  einvoice_id uuid NOT NULL REFERENCES einvoices(id),
  line_no int NOT NULL,
  description text NOT NULL,
  net_cents bigint NOT NULL,
  vat_rate numeric NOT NULL,
  vat_cents bigint NOT NULL,
  vat_category text NOT NULL CHECK (vat_category IN ('S','Z','E','AE','K','G','O')),
  cn_code text,
  net_mass_kg numeric
);
CREATE INDEX einvoice_lines_einvoice_idx ON einvoice_lines(einvoice_id);
CREATE INDEX einvoice_lines_client_category_idx ON einvoice_lines(client_company_id, vat_category);

ALTER TABLE einvoice_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE einvoice_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY einvoice_lines_tenant_isolation ON einvoice_lines
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);
GRANT SELECT, INSERT ON einvoice_lines TO bookkeeping_app;

ALTER TABLE bill_lines ADD COLUMN vat_category text NOT NULL DEFAULT 'S'
  CHECK (vat_category IN ('S','Z','E','AE','K','G','O'));
ALTER TABLE bill_lines ADD COLUMN vat_deductible boolean NOT NULL DEFAULT true;
ALTER TABLE bill_lines ADD COLUMN cn_code text;
ALTER TABLE bill_lines ADD COLUMN net_mass_kg numeric;

-- ECSL reports per member state, and reverse-charge eligibility is a country question.
-- Not derived from the vat_no prefix: vat_no is nullable and often blank on existing rows.
ALTER TABLE parties ADD COLUMN country_code char(2) NOT NULL DEFAULT 'LV';
