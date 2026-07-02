CREATE TABLE proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  type text NOT NULL CHECK (type IN ('posting','bank_match','declaration','task')),
  status text NOT NULL DEFAULT 'suggested'
    CHECK (status IN ('suggested','pending_approval','approved','rejected','posted')),
  payload jsonb NOT NULL,
  rationale jsonb NOT NULL,
  document_id uuid REFERENCES documents(id),
  resolved_entry_id uuid REFERENCES journal_entries(id),
  resolved_by text,
  resolved_at timestamptz,
  reject_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX proposals_client_status_idx ON proposals(client_company_id, status);

-- Core fields are immutable; only lifecycle fields may change.
CREATE OR REPLACE FUNCTION forbid_proposal_core_mutation() RETURNS trigger AS $$
BEGIN
  IF NEW.type <> OLD.type OR NEW.payload <> OLD.payload
     OR NEW.rationale <> OLD.rationale OR NEW.created_at <> OLD.created_at
     OR NEW.client_company_id <> OLD.client_company_id THEN
    RAISE EXCEPTION 'proposal core fields (type, payload, rationale, created_at) are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER proposals_core_immutable
  BEFORE UPDATE ON proposals
  FOR EACH ROW EXECUTE FUNCTION forbid_proposal_core_mutation();

ALTER TABLE proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE proposals FORCE ROW LEVEL SECURITY;
CREATE POLICY proposals_tenant_isolation ON proposals
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);

-- INSERT (create), SELECT (read), UPDATE (lifecycle transitions). No DELETE/TRUNCATE.
GRANT SELECT, INSERT, UPDATE ON proposals TO bookkeeping_app;
