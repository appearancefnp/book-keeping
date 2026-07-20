-- Accounts receivable: open-item tracking on outbound einvoices + payments (M4 slice A).
-- The outbound einvoice row IS the receivable (mirrors bills for payables).
ALTER TABLE einvoices ADD COLUMN customer_party_id uuid REFERENCES parties(id);
ALTER TABLE einvoices ADD COLUMN due_date date;
ALTER TABLE einvoices ADD COLUMN amount_paid_cents bigint NOT NULL DEFAULT 0;
-- Nullable, no table default: set to 'open' only on the outbound issue path so inbound
-- rows stay NULL and never surface in AR aging/settlement.
ALTER TABLE einvoices ADD COLUMN status text
  CHECK (status IN ('open','partially_paid','paid','void'));
CREATE INDEX einvoices_ar_idx ON einvoices(client_company_id, direction, status, due_date);

-- Per-customer default payment terms (days from issue) used to compute an invoice due date.
ALTER TABLE parties ADD COLUMN payment_terms_days int;

CREATE TABLE invoice_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  einvoice_id uuid NOT NULL REFERENCES einvoices(id),
  amount_cents bigint NOT NULL,
  paid_date date NOT NULL,
  method text NOT NULL CHECK (method IN ('bank_match','manual')),
  bank_transaction_id uuid REFERENCES bank_transactions(id),
  journal_entry_id uuid NOT NULL REFERENCES journal_entries(id),
  cleared_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invoice_payments_einvoice_idx ON invoice_payments(einvoice_id);
CREATE INDEX invoice_payments_banktxn_idx ON invoice_payments(client_company_id, bank_transaction_id);

ALTER TABLE invoice_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_payments FORCE ROW LEVEL SECURITY;
CREATE POLICY invoice_payments_tenant_isolation ON invoice_payments
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON invoice_payments TO bookkeeping_app;
