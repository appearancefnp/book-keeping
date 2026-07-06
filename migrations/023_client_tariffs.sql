-- Per-client monthly retainer (G4 slice 1). Firm-admin managed, cross-client:
-- NO row-level security — every access path filters by firm_id via client_companies.
CREATE TABLE client_tariffs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id     uuid NOT NULL REFERENCES client_companies(id),
  monthly_amount_cents  bigint NOT NULL CHECK (monthly_amount_cents >= 0),
  currency              char(3) NOT NULL DEFAULT 'EUR',
  vat_rate              text NOT NULL,          -- decimal string percent, e.g. '21'
  effective_from        date NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid,                    -- actor user id
  UNIQUE (client_company_id, effective_from)
);
CREATE INDEX client_tariffs_lookup_idx
  ON client_tariffs(client_company_id, effective_from DESC);

GRANT SELECT, INSERT, UPDATE ON client_tariffs TO bookkeeping_app;
