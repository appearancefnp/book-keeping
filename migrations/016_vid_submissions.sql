CREATE TABLE vid_submission_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  einvoice_id uuid NOT NULL REFERENCES einvoices(id),
  attempted_at timestamptz NOT NULL DEFAULT now(),
  ok boolean NOT NULL,
  detail text
);
CREATE INDEX vid_attempts_einvoice_idx ON vid_submission_attempts(einvoice_id);

ALTER TABLE vid_submission_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE vid_submission_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY vid_attempts_tenant_isolation ON vid_submission_attempts
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);

GRANT SELECT, INSERT ON vid_submission_attempts TO bookkeeping_app;
