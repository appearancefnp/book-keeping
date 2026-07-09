CREATE TABLE payroll_settings (
  client_company_id uuid PRIMARY KEY REFERENCES client_companies(id),
  mun_regime boolean NOT NULL DEFAULT false,
  acc_wage_expense text NOT NULL DEFAULT '7210',
  acc_severance_expense text NOT NULL DEFAULT '7230',
  acc_employer_vsaoi_expense text NOT NULL DEFAULT '7310',
  acc_risk_duty_expense text NOT NULL DEFAULT '7330',
  acc_wages_payable text NOT NULL DEFAULT '5610',
  acc_iin_payable text NOT NULL DEFAULT '5720',
  acc_vsaoi_payable text NOT NULL DEFAULT '57221',
  acc_risk_duty_payable text NOT NULL DEFAULT '5723',
  acc_other_deductions_payable text NOT NULL DEFAULT '5620',
  acc_vacation_accrual_liability text NOT NULL DEFAULT '5411',
  acc_vacation_accrual_vsaoi_liability text NOT NULL DEFAULT '5412'
);

ALTER TABLE payroll_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY payroll_settings_tenant_isolation ON payroll_settings
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON payroll_settings TO bookkeeping_app;
