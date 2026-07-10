CREATE TABLE absences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  employee_id uuid NOT NULL REFERENCES employees(id),
  type text NOT NULL CHECK (type IN ('vacation','sick_a','sick_b','unpaid','other')),
  date_from date NOT NULL,
  date_to date NOT NULL,
  source_order_id uuid,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (date_to >= date_from)
);
CREATE INDEX absences_employee_idx ON absences(employee_id, date_from);

CREATE TABLE pay_components (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  employee_id uuid NOT NULL REFERENCES employees(id),
  year int NOT NULL,
  month int NOT NULL CHECK (month BETWEEN 1 AND 12),
  kind text NOT NULL CHECK (kind IN
    ('bonus','night_hours','overtime_hours','holiday_hours','hours_worked',
     'other_taxable','severance_exempt','deduction')),
  amount numeric(12,2),   -- money kinds
  quantity numeric(7,2),  -- hour kinds
  source_order_id uuid,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (kind IN ('night_hours','overtime_hours','holiday_hours','hours_worked')
       AND quantity IS NOT NULL AND quantity > 0 AND amount IS NULL)
    OR
    (kind IN ('bonus','other_taxable','severance_exempt','deduction')
       AND amount IS NOT NULL AND amount > 0 AND quantity IS NULL)
  )
);
CREATE INDEX pay_components_employee_month_idx ON pay_components(employee_id, year, month);

ALTER TABLE absences ENABLE ROW LEVEL SECURITY;
ALTER TABLE absences FORCE ROW LEVEL SECURITY;
CREATE POLICY absences_tenant_isolation ON absences
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);

ALTER TABLE pay_components ENABLE ROW LEVEL SECURITY;
ALTER TABLE pay_components FORCE ROW LEVEL SECURITY;
CREATE POLICY pay_components_tenant_isolation ON pay_components
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);

GRANT SELECT, INSERT ON absences TO bookkeeping_app;
GRANT SELECT, INSERT ON pay_components TO bookkeeping_app;
