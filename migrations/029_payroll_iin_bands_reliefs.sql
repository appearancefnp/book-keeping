-- Phase-2 calc extension: configurable progressive IIN band 3 + pensioner/repression reliefs.

-- Per-company toggle for monthly IIN withholding. Default false = legally-correct flat 25.5%
-- (LV 2025+: employer withholds one 25.5% rate; 33%/36% are settled in the annual declaration).
-- true = progressive 25.5/33/36 monthly, matching public salary calculators' estimate.
ALTER TABLE payroll_settings ADD COLUMN iin_progressive_monthly boolean NOT NULL DEFAULT false;

-- Personal attributes that change the reliefs (analogous to disability_group). Monthly, per doc 2.2.
ALTER TABLE employee_tax_status ADD COLUMN is_pensioner boolean NOT NULL DEFAULT false;
ALTER TABLE employee_tax_status ADD COLUMN is_repressed boolean NOT NULL DEFAULT false;

INSERT INTO tax_rules(rule_type, value, effective_from, note) VALUES
  ('payroll_iin_rate_band3', '36', '2025-01-01', 'IIN marginal rate above the 2nd threshold (33% + 3% surcharge)'),
  ('payroll_iin_threshold2_annual', '200000', '2025-01-01', 'IIN 2nd threshold EUR/year (above: +3% surcharge)'),
  ('payroll_pensioner_minimum_monthly', '1000', '2025-01-01', 'Pensioner non-taxable minimum EUR/month (replaces the standard minimum)'),
  ('payroll_repression_relief_monthly', '154', '2021-01-01', 'Politically-repressed / national-resistance relief EUR/month');
