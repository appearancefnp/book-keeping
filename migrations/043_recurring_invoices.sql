-- Recurring / subscription invoices (M4 slice C-recurring). A template holds the invoice payload
-- plus an anchor-day/interval-months cadence and end conditions; the recurring_generate job bills
-- the latest occurrence on/before today and self-perpetuates while active.

CREATE TABLE recurring_invoice_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  customer_party_id uuid NOT NULL REFERENCES parties(id),
  recipient_peppol_id text NOT NULL,          -- parties store no Peppol endpoint; sendInvoice needs it
  invoice_payload jsonb NOT NULL,             -- EInvoice minus invoiceNumber/issueDate/dueDate
  anchor_day int NOT NULL CHECK (anchor_day BETWEEN 1 AND 31),
  interval_months int NOT NULL CHECK (interval_months > 0),
  next_run_date date NOT NULL,
  payment_terms_days int,                     -- null → fall back to the customer party's terms
  end_date date,
  occurrences_remaining int,                  -- null → unlimited
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX recurring_templates_due_idx
  ON recurring_invoice_templates(client_company_id, active, next_run_date);

ALTER TABLE recurring_invoice_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE recurring_invoice_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY recurring_templates_tenant_isolation ON recurring_invoice_templates
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON recurring_invoice_templates TO bookkeeping_app;

-- Control-plane read for the chain reaper (mirrors dunning_policy_supervisor_read). Permissive
-- policies are OR-combined, so this re-opens cross-tenant read for the supervisor role only.
GRANT SELECT ON recurring_invoice_templates TO bookkeeping_supervisor;
CREATE POLICY recurring_templates_supervisor_read ON recurring_invoice_templates
  TO bookkeeping_supervisor USING (true);

-- Extend the proposals type CHECK so an approval-gated recurring invoice can be held for review.
ALTER TABLE proposals DROP CONSTRAINT proposals_type_check;
ALTER TABLE proposals ADD CONSTRAINT proposals_type_check
  CHECK (type IN ('posting','bank_match','declaration','task','recurring_invoice'));
