-- Minimal privilege grant to the runtime app role.
-- bookkeeping_app is NOT the table owner; admin runs migrations.
-- No DELETE, TRUNCATE, or UPDATE on journal tables (enforced here + append-only triggers).
GRANT SELECT, INSERT ON firms, client_companies, accounts, journal_entries, journal_lines, audit_log TO bookkeeping_app;
GRANT SELECT, INSERT, UPDATE ON accounting_periods TO bookkeeping_app;
GRANT SELECT ON schema_migrations TO bookkeeping_app;
