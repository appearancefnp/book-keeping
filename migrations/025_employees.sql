CREATE TABLE employees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  first_name text NOT NULL,
  last_name text NOT NULL,
  personal_code text NOT NULL,
  position text NOT NULL,
  contract_no text NOT NULL,
  contract_date date NOT NULL,
  contract_type text NOT NULL CHECK (contract_type IN ('indefinite','fixed_term')),
  wage_type text NOT NULL CHECK (wage_type IN ('monthly','hourly')),
  wage numeric(12,2) NOT NULL CHECK (wage > 0),
  hired_on date NOT NULL,
  terminated_on date,
  opening_vacation_days numeric(6,2) NOT NULL DEFAULT 0,
  opening_balance_date date NOT NULL,  -- the date the employee entered THIS system (doc 2.1)
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_company_id, personal_code)
);
CREATE INDEX employees_client_idx ON employees(client_company_id);

CREATE TABLE employee_tax_status (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  employee_id uuid NOT NULL REFERENCES employees(id),
  year int NOT NULL,
  month int NOT NULL CHECK (month BETWEEN 1 AND 12),
  tax_book_active boolean NOT NULL,
  dependents int NOT NULL DEFAULT 0 CHECK (dependents >= 0),
  disability_group int NOT NULL DEFAULT 0 CHECK (disability_group BETWEEN 0 AND 3),
  UNIQUE (employee_id, year, month)
);

CREATE TABLE employee_opening_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  employee_id uuid NOT NULL REFERENCES employees(id),
  year int NOT NULL,
  month int NOT NULL CHECK (month BETWEEN 1 AND 12),
  avg_base_gross numeric(12,2) NOT NULL CHECK (avg_base_gross >= 0),
  worked_days int NOT NULL CHECK (worked_days >= 0),
  UNIQUE (employee_id, year, month)
);

ALTER TABLE employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE employees FORCE ROW LEVEL SECURITY;
CREATE POLICY employees_tenant_isolation ON employees
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);

ALTER TABLE employee_tax_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_tax_status FORCE ROW LEVEL SECURITY;
CREATE POLICY employee_tax_status_tenant_isolation ON employee_tax_status
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);

ALTER TABLE employee_opening_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_opening_history FORCE ROW LEVEL SECURITY;
CREATE POLICY employee_opening_history_tenant_isolation ON employee_opening_history
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON employees TO bookkeeping_app;
GRANT SELECT, INSERT, UPDATE ON employee_tax_status TO bookkeeping_app;
GRANT SELECT, INSERT ON employee_opening_history TO bookkeeping_app;
