CREATE TABLE document_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  document_id uuid NOT NULL REFERENCES documents(id),
  extracted_data jsonb NOT NULL,
  confidence jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX document_versions_doc_idx ON document_versions(document_id);

-- Append-only: reuse forbid_mutation() defined in 005_journal.sql
CREATE TRIGGER document_versions_append_only
  BEFORE UPDATE OR DELETE ON document_versions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

ALTER TABLE document_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY document_versions_tenant_isolation ON document_versions
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);

-- Append-only: SELECT + INSERT only (no UPDATE/DELETE)
GRANT SELECT, INSERT ON document_versions TO bookkeeping_app;
