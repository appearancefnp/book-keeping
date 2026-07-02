CREATE TABLE einvoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  direction text NOT NULL CHECK (direction IN ('outbound','inbound')),
  invoice_number text NOT NULL,
  issue_date date NOT NULL,
  grand_total_cents bigint NOT NULL,
  currency char(3) NOT NULL,
  ubl_xml text NOT NULL,
  peppol_status text NOT NULL DEFAULT 'queued' CHECK (peppol_status IN ('queued','sent','delivered','failed','received')),
  peppol_message_id text,
  vid_status text NOT NULL DEFAULT 'pending' CHECK (vid_status IN ('pending','submitted','failed','not_required')),
  vid_due_date date,
  journal_entry_id uuid REFERENCES journal_entries(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX einvoices_client_idx ON einvoices(client_company_id, direction, peppol_status);
CREATE INDEX einvoices_vid_due_idx ON einvoices(client_company_id, vid_status, vid_due_date);

ALTER TABLE einvoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE einvoices FORCE ROW LEVEL SECURITY;
CREATE POLICY einvoices_tenant_isolation ON einvoices
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON einvoices TO bookkeeping_app;
