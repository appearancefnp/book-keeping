-- Accounts payable: vendor bills and their line detail (M2, Plan 1).
CREATE TABLE bills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  vendor_party_id uuid NOT NULL REFERENCES parties(id),
  bill_number text NOT NULL,
  issue_date date NOT NULL,
  due_date date NOT NULL,
  currency char(3) NOT NULL,
  net_cents bigint NOT NULL,
  vat_cents bigint NOT NULL,
  grand_total_cents bigint NOT NULL,
  amount_paid_cents bigint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'awaiting_approval'
    CHECK (status IN ('awaiting_approval','open','partially_paid','paid','void')),
  source text NOT NULL CHECK (source IN ('manual','ocr','peppol')),
  posting_proposal_id uuid REFERENCES proposals(id),
  journal_entry_id uuid REFERENCES journal_entries(id),
  document_id uuid REFERENCES documents(id),
  einvoice_id uuid REFERENCES einvoices(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bills_client_status_due_idx ON bills(client_company_id, status, due_date);

ALTER TABLE bills ENABLE ROW LEVEL SECURITY;
ALTER TABLE bills FORCE ROW LEVEL SECURITY;
CREATE POLICY bills_tenant_isolation ON bills
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON bills TO bookkeeping_app;

CREATE TABLE bill_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  bill_id uuid NOT NULL REFERENCES bills(id),
  line_no int NOT NULL,
  description text NOT NULL,
  expense_account text NOT NULL,
  net_cents bigint NOT NULL,
  vat_rate numeric NOT NULL,
  vat_cents bigint NOT NULL
);
CREATE INDEX bill_lines_bill_idx ON bill_lines(bill_id);

ALTER TABLE bill_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE bill_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY bill_lines_tenant_isolation ON bill_lines
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON bill_lines TO bookkeeping_app;

ALTER TABLE parties ADD COLUMN iban text;
