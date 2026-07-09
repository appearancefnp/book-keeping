CREATE TABLE payroll_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  year int NOT NULL,
  month int NOT NULL CHECK (month BETWEEN 1 AND 12),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','computed','approved')),
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  UNIQUE (client_company_id, year, month)
);

CREATE TABLE payroll_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  run_id uuid NOT NULL REFERENCES payroll_runs(id),
  employee_id uuid NOT NULL REFERENCES employees(id),
  worked_days int NOT NULL,
  total_work_days int NOT NULL,
  base numeric(12,2) NOT NULL,
  premiums numeric(12,2) NOT NULL,
  bonus numeric(12,2) NOT NULL,
  vacation_pay numeric(12,2) NOT NULL,
  sick_pay numeric(12,2) NOT NULL,
  other_taxable numeric(12,2) NOT NULL,
  severance_exempt numeric(12,2) NOT NULL,
  gross numeric(12,2) NOT NULL,
  avg_base_gross numeric(12,2) NOT NULL,  -- base+premiums+bonus: the doc-3.2 earnings base for future averages
  avg_daily numeric(12,2) NOT NULL,       -- the average daily earnings used this month (accrual + audit trail)
  vsaoi_employee numeric(12,2) NOT NULL,
  iin numeric(12,2) NOT NULL,
  other_deductions numeric(12,2) NOT NULL,
  net numeric(12,2) NOT NULL,
  payout numeric(12,2) NOT NULL,
  vsaoi_employer numeric(12,2) NOT NULL,
  risk_duty numeric(12,2) NOT NULL,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  explanation jsonb NOT NULL DEFAULT '[]'::jsonb,
  UNIQUE (run_id, employee_id)
);
CREATE INDEX payroll_items_employee_idx ON payroll_items(employee_id);

CREATE TABLE vacation_accruals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  employee_id uuid NOT NULL REFERENCES employees(id),
  year int NOT NULL,
  month int NOT NULL CHECK (month BETWEEN 1 AND 12),
  balance_days numeric(7,2) NOT NULL,
  avg_daily numeric(12,2) NOT NULL,
  accrual numeric(14,2) NOT NULL,
  accrual_vsaoi numeric(14,2) NOT NULL,
  UNIQUE (employee_id, year, month)
);

ALTER TABLE payroll_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY payroll_runs_tenant_isolation ON payroll_runs
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);

ALTER TABLE payroll_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_items FORCE ROW LEVEL SECURITY;
CREATE POLICY payroll_items_tenant_isolation ON payroll_items
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);

ALTER TABLE vacation_accruals ENABLE ROW LEVEL SECURITY;
ALTER TABLE vacation_accruals FORCE ROW LEVEL SECURITY;
CREATE POLICY vacation_accruals_tenant_isolation ON vacation_accruals
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON payroll_runs TO bookkeeping_app;
GRANT SELECT, INSERT, DELETE ON payroll_items TO bookkeeping_app;  -- DELETE: recompute wipes draft items
GRANT SELECT, INSERT, UPDATE ON vacation_accruals TO bookkeeping_app;
