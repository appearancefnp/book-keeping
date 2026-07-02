CREATE TABLE device_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  owner text NOT NULL,               -- the user id the token belongs to
  token text NOT NULL,
  platform text NOT NULL CHECK (platform IN ('ios','android')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_company_id, token)
);
CREATE INDEX device_tokens_client_idx ON device_tokens(client_company_id);

ALTER TABLE device_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY device_tokens_tenant ON device_tokens
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);

GRANT SELECT, INSERT ON device_tokens TO bookkeeping_app;
