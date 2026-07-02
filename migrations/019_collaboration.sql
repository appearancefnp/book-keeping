CREATE TABLE tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  title text NOT NULL,
  detail text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  author text NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  recipient text NOT NULL,
  kind text NOT NULL,
  message text NOT NULL,
  read boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX comments_entity_idx ON comments(client_company_id, entity_type, entity_id);
CREATE INDEX notifications_recipient_idx ON notifications(client_company_id, recipient, read);

DO $$ DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tasks','comments','notifications'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I_tenant ON %I USING (client_company_id = current_setting(''app.current_client_id'', true)::uuid) WITH CHECK (client_company_id = current_setting(''app.current_client_id'', true)::uuid)', t, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO bookkeeping_app', t);
  END LOOP;
END $$;
