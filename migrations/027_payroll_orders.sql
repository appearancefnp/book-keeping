CREATE TABLE payroll_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  order_type text NOT NULL CHECK (order_type IN ('hire','termination','bonus','vacation','wage_change')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved')),
  employee_ids uuid[] NOT NULL,
  amount numeric(12,2),
  date_from date,
  date_to date,
  effective_date date NOT NULL,
  reason text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_by text,
  approved_at timestamptz
);
CREATE INDEX payroll_orders_client_idx ON payroll_orders(client_company_id, order_type, created_at DESC);

ALTER TABLE payroll_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_orders FORCE ROW LEVEL SECURITY;
CREATE POLICY payroll_orders_tenant_isolation ON payroll_orders
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON payroll_orders TO bookkeeping_app;
