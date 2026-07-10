-- Latvian payroll parameters (regulation-as-code; extend with new dated rows on change).
-- Percent values are plain numbers ('25.5' = 25.5%); money values are EUR.
INSERT INTO tax_rules(rule_type, value, effective_from, note) VALUES
  ('payroll_iin_rate_basic', '25.5', '2025-01-01', 'IIN base rate'),
  ('payroll_iin_rate_top', '33', '2025-01-01', 'IIN rate above the annual threshold'),
  ('payroll_iin_threshold_annual', '105300', '2025-01-01', 'IIN progressive threshold EUR/year (monthly = /12)'),
  ('payroll_nontaxable_minimum_monthly', '510', '2025-01-01', 'Fixed non-taxable minimum EUR/month'),
  ('payroll_nontaxable_minimum_monthly', '550', '2026-01-01', 'Fixed non-taxable minimum EUR/month (2026)'),
  ('payroll_dependent_relief_monthly', '250', '2022-01-01', 'Relief per dependent EUR/month'),
  ('payroll_disability_relief_group12_monthly', '154', '2021-01-01', 'Disability group I/II relief EUR/month'),
  ('payroll_disability_relief_group3_monthly', '120', '2021-01-01', 'Disability group III relief EUR/month'),
  ('payroll_vsaoi_rate_employee', '10.5', '2021-01-01', 'VSAOI employee share %'),
  ('payroll_vsaoi_rate_employer', '23.59', '2021-01-01', 'VSAOI employer share %'),
  ('payroll_vsaoi_cap_annual', '105300', '2025-01-01', 'VSAOI object cap EUR/year (above: solidarity tax, same rates)'),
  ('payroll_min_wage_monthly', '740', '2025-01-01', 'Minimum monthly wage EUR'),
  ('payroll_min_wage_monthly', '780', '2026-01-01', 'Minimum monthly wage EUR (2026)'),
  ('payroll_risk_duty_monthly', '0.36', '2022-01-01', 'Business risk state duty EUR/employee/month'),
  ('payroll_premium_night_pct', '50', '2021-01-01', 'Night work premium, % of rate (DL 67)'),
  ('payroll_premium_overtime_pct', '100', '2021-01-01', 'Overtime premium, % of rate (DL 68; Saeima may lower)'),
  ('payroll_premium_holiday_pct', '100', '2021-01-01', 'Public-holiday work premium, % of rate'),
  ('payroll_sick_pay_day2_3_pct', '75', '2021-01-01', 'A-lapa: sick days 2-3, % of average earnings'),
  ('payroll_sick_pay_day4_9_pct', '80', '2021-01-01', 'A-lapa: sick days 4-9, % of average earnings'),
  ('payroll_vacation_days_per_month', '1.67', '2021-01-01', 'Vacation accrual, working days per month'),
  ('payroll_deduction_cap_pct', '20', '2021-01-01', 'Cap on other deductions, % of payable amount (DL 80)');
