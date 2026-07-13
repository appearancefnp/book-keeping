-- Accounts payable: settlements and pay runs (M2, Plan 2).
CREATE TABLE pay_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  created_by uuid,
  total_cents bigint NOT NULL DEFAULT 0,
  pain001_xml text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'generated' CHECK (status IN ('generated')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pay_runs_client_idx ON pay_runs(client_company_id, created_at);

ALTER TABLE pay_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE pay_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY pay_runs_tenant_isolation ON pay_runs
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON pay_runs TO bookkeeping_app;

CREATE TABLE bill_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  bill_id uuid NOT NULL REFERENCES bills(id),
  amount_cents bigint NOT NULL,
  paid_date date NOT NULL,
  method text NOT NULL CHECK (method IN ('pay_run','bank_match','manual')),
  pay_run_id uuid REFERENCES pay_runs(id),
  bank_transaction_id uuid REFERENCES bank_transactions(id),
  journal_entry_id uuid NOT NULL REFERENCES journal_entries(id),
  cleared_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bill_payments_bill_idx ON bill_payments(bill_id);
CREATE INDEX bill_payments_uncleared_idx ON bill_payments(client_company_id, method, cleared_at);

ALTER TABLE bill_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE bill_payments FORCE ROW LEVEL SECURITY;
CREATE POLICY bill_payments_tenant_isolation ON bill_payments
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON bill_payments TO bookkeeping_app;
