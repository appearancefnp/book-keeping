CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  source text NOT NULL CHECK (source IN ('mobile','web','email','peppol')),
  storage_key text NOT NULL,
  mime text NOT NULL,
  status text NOT NULL DEFAULT 'received'
    CHECK (status IN ('received','extracting','extracted','needs_review','posted','rejected')),
  party_id uuid REFERENCES parties(id),
  journal_entry_id uuid REFERENCES journal_entries(id),
  extracted_data jsonb,
  uploaded_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX documents_client_status_idx ON documents(client_company_id, status);

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents FORCE ROW LEVEL SECURITY;
CREATE POLICY documents_tenant_isolation ON documents
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON documents TO bookkeeping_app;
