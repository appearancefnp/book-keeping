-- Client-onboarding templates (G4 slice 2). Firm-admin managed, cross-client:
-- NO row-level security — every access path filters by firm_id.
CREATE TABLE onboarding_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id     uuid NOT NULL REFERENCES firms(id),
  name        text NOT NULL,
  body        jsonb NOT NULL,   -- { accounts:[{code,name,type}], autonomy:[{operationType,mode,materialThresholdCents}], tariff:{monthlyAmountCents,currency,vatRate}|null }
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  UNIQUE (firm_id, name)
);
CREATE INDEX onboarding_templates_firm_idx ON onboarding_templates(firm_id);

GRANT SELECT, INSERT ON onboarding_templates TO bookkeeping_app;
