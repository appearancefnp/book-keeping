-- Branding for the invoice document renderer (G4 slice 3b).
ALTER TABLE invoice_profiles ADD COLUMN logo_blob_key text;
ALTER TABLE invoice_profiles ADD COLUMN footer text;
