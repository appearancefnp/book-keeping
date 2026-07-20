-- Expense claims (M6): employee self-service claims -> approval queue -> bank reimbursement.
-- The employee is the payee; claims mirror bills (proposal-gated posting, payables-style settlement).

-- Self-service link + payout target.
ALTER TABLE employees ADD COLUMN user_id uuid REFERENCES users(id);
ALTER TABLE employees ADD COLUMN iban text;
CREATE UNIQUE INDEX employees_user_link_uidx
  ON employees(client_company_id, user_id) WHERE user_id IS NOT NULL;

CREATE TABLE expense_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  employee_id uuid NOT NULL REFERENCES employees(id),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','submitted','approved','reimbursed','rejected')),
  description text NOT NULL DEFAULT '',
  currency char(3) NOT NULL DEFAULT 'EUR',
  total_net_cents bigint NOT NULL DEFAULT 0,
  total_vat_cents bigint NOT NULL DEFAULT 0,
  total_cents bigint NOT NULL DEFAULT 0,
  posting_proposal_id uuid REFERENCES proposals(id),
  journal_entry_id uuid REFERENCES journal_entries(id),
  reimbursed_at timestamptz,
  reimbursement_entry_id uuid REFERENCES journal_entries(id),
  reimbursement_bank_transaction_id uuid REFERENCES bank_transactions(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
-- One claim per settling bank transaction (mirror of invoice_payments' dedup).
CREATE UNIQUE INDEX expense_claims_reimb_txn_uidx
  ON expense_claims(reimbursement_bank_transaction_id)
  WHERE reimbursement_bank_transaction_id IS NOT NULL;
CREATE INDEX expense_claims_client_status_idx ON expense_claims(client_company_id, status, created_at);

CREATE TABLE expense_claim_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  claim_id uuid NOT NULL REFERENCES expense_claims(id) ON DELETE CASCADE,
  line_no int NOT NULL,
  kind text NOT NULL CHECK (kind IN ('receipt','mileage')),
  line_date date NOT NULL,
  description text NOT NULL,
  expense_account text NOT NULL,
  net_cents bigint NOT NULL CHECK (net_cents >= 0),
  vat_cents bigint NOT NULL DEFAULT 0 CHECK (vat_cents >= 0),
  vat_deductible boolean NOT NULL DEFAULT false,
  document_id uuid REFERENCES documents(id),
  km numeric(8,1),
  rate_cents bigint
);
CREATE INDEX expense_claim_lines_claim_idx ON expense_claim_lines(claim_id);

CREATE TABLE expense_settings (
  client_company_id uuid PRIMARY KEY REFERENCES client_companies(id),
  mileage_rate_cents_per_km bigint NOT NULL DEFAULT 30
);

-- Receipt photos uploaded for a claim line bypass the intake pipeline.
ALTER TABLE documents DROP CONSTRAINT documents_source_check;
ALTER TABLE documents ADD CONSTRAINT documents_source_check
  CHECK (source IN ('mobile','web','email','peppol','expense'));

ALTER TABLE expense_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE expense_claims FORCE ROW LEVEL SECURITY;
CREATE POLICY expense_claims_tenant_isolation ON expense_claims
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);
ALTER TABLE expense_claim_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE expense_claim_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY expense_claim_lines_tenant_isolation ON expense_claim_lines
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);
ALTER TABLE expense_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE expense_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY expense_settings_tenant_isolation ON expense_settings
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON expense_claims TO bookkeeping_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON expense_claim_lines TO bookkeeping_app;
GRANT SELECT, INSERT, UPDATE ON expense_settings TO bookkeeping_app;
