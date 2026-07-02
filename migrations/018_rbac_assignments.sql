CREATE TABLE user_client_assignments (
  user_id uuid NOT NULL REFERENCES users(id),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  PRIMARY KEY (user_id, client_company_id)
);
GRANT SELECT, INSERT, DELETE ON user_client_assignments TO bookkeeping_app;
