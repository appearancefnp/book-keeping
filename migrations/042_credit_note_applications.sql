-- Credit-note application (M4 integration): a referenced AR credit note settles its
-- invoice like a payment. No GL posting here — sendCreditNote already reversed the
-- receivable; this records the application so open-item status and dunning agree with GL.
ALTER TABLE invoice_payments DROP CONSTRAINT invoice_payments_method_check;
ALTER TABLE invoice_payments ADD CONSTRAINT invoice_payments_method_check
  CHECK (method IN ('bank_match','manual','credit_note'));
ALTER TABLE invoice_payments ADD COLUMN credit_note_einvoice_id uuid REFERENCES einvoices(id);
-- One application per credit note.
CREATE UNIQUE INDEX invoice_payments_credit_note_uidx
  ON invoice_payments(credit_note_einvoice_id) WHERE credit_note_einvoice_id IS NOT NULL;
