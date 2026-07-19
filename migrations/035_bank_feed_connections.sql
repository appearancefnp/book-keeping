CREATE TABLE bank_feed_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  provider text NOT NULL DEFAULT 'gocardless',
  provider_requisition_id text NOT NULL,
  institution_id text NOT NULL,
  institution_name text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','linked','expired','revoked')),
  consent_expires_at timestamptz,
  last_error text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_company_id, provider_requisition_id)
);
CREATE INDEX bank_feed_connections_client_status_idx ON bank_feed_connections(client_company_id, status);

CREATE TABLE bank_feed_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES bank_feed_connections(id) ON DELETE CASCADE,
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  provider_account_id text NOT NULL,
  iban text NOT NULL DEFAULT '',
  currency char(3) NOT NULL DEFAULT 'EUR',
  last_synced_date date,
  UNIQUE (connection_id, provider_account_id)
);
CREATE INDEX bank_feed_accounts_client_idx ON bank_feed_accounts(client_company_id);

ALTER TABLE bank_feed_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_feed_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY bank_feed_connections_tenant_isolation ON bank_feed_connections
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);

ALTER TABLE bank_feed_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_feed_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY bank_feed_accounts_tenant_isolation ON bank_feed_accounts
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON bank_feed_connections TO bookkeeping_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON bank_feed_accounts TO bookkeeping_app;
