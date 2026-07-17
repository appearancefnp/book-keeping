-- Credit notes (M7): AR credit notes ride on einvoices (doc_type discriminator);
-- AP vendor credit notes get their own tables (a credit note is not a payable you pay).

-- AR side: discriminate einvoices, carry the optional EN 16931 preceding-invoice reference.
ALTER TABLE einvoices ADD COLUMN doc_type text NOT NULL DEFAULT 'invoice'
  CHECK (doc_type IN ('invoice','credit_note'));
ALTER TABLE einvoices ADD COLUMN corrected_invoice_number text;

-- AP side: vendor credit notes. Shaped like bills MINUS settlement (no amount_paid, no pay-run).
CREATE TABLE vendor_credit_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  vendor_party_id uuid NOT NULL REFERENCES parties(id),
  credit_note_number text NOT NULL,
  issue_date date NOT NULL,
  currency char(3) NOT NULL,
  net_cents bigint NOT NULL,
  vat_cents bigint NOT NULL,
  grand_total_cents bigint NOT NULL,
  corrected_bill_number text,
  status text NOT NULL DEFAULT 'awaiting_approval'
    CHECK (status IN ('awaiting_approval','applied','void')),
  source text NOT NULL CHECK (source IN ('manual','peppol')),
  posting_proposal_id uuid REFERENCES proposals(id),
  journal_entry_id uuid REFERENCES journal_entries(id),
  document_id uuid REFERENCES documents(id),
  einvoice_id uuid REFERENCES einvoices(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vendor_credit_notes_client_status_idx
  ON vendor_credit_notes(client_company_id, status, issue_date);

ALTER TABLE vendor_credit_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_credit_notes FORCE ROW LEVEL SECURITY;
CREATE POLICY vendor_credit_notes_tenant_isolation ON vendor_credit_notes
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON vendor_credit_notes TO bookkeeping_app;

CREATE TABLE vendor_credit_note_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  credit_note_id uuid NOT NULL REFERENCES vendor_credit_notes(id),
  line_no int NOT NULL,
  description text NOT NULL,
  expense_account text NOT NULL,
  net_cents bigint NOT NULL,
  vat_rate numeric NOT NULL,
  vat_cents bigint NOT NULL
);
CREATE INDEX vendor_credit_note_lines_cn_idx ON vendor_credit_note_lines(credit_note_id);

ALTER TABLE vendor_credit_note_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_credit_note_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY vendor_credit_note_lines_tenant_isolation ON vendor_credit_note_lines
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON vendor_credit_note_lines TO bookkeeping_app;
