CREATE TABLE bank_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  account text NOT NULL,
  booking_date date NOT NULL,
  amount_cents bigint NOT NULL,
  currency char(3) NOT NULL,
  side text NOT NULL CHECK (side IN ('credit','debit')),
  reference text NOT NULL DEFAULT '',
  counterparty text NOT NULL DEFAULT '',
  end_to_end_id text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'unmatched' CHECK (status IN ('unmatched','matched','reconciled')),
  matched_entry_id uuid REFERENCES journal_entries(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_company_id, account, end_to_end_id, amount_cents, booking_date)
);
CREATE INDEX bank_txn_client_status_idx ON bank_transactions(client_company_id, status);

ALTER TABLE bank_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_transactions FORCE ROW LEVEL SECURITY;
CREATE POLICY bank_txn_tenant_isolation ON bank_transactions
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON bank_transactions TO bookkeeping_app;
