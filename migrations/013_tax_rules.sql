CREATE TABLE tax_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_type text NOT NULL,
  value text NOT NULL,              -- decimal string, e.g. '21' (percent) or amount
  effective_from date NOT NULL,
  note text,
  UNIQUE (rule_type, effective_from)
);
CREATE INDEX tax_rules_lookup_idx ON tax_rules(rule_type, effective_from DESC);

-- National regulation data: no tenant column, no RLS. App reads only; admin (migrations) writes.
GRANT SELECT ON tax_rules TO bookkeeping_app;

-- Seed Latvian VAT rates (regulation-as-code; extend with new dated rows on change).
INSERT INTO tax_rules(rule_type, value, effective_from, note) VALUES
  ('vat_standard_rate', '21', '2013-01-01', 'LV standard VAT rate 21%'),
  ('vat_reduced_rate',  '12', '2011-07-01', 'LV reduced VAT rate 12%'),
  ('vat_super_reduced_rate', '5', '2018-01-01', 'LV super-reduced VAT rate 5%');
