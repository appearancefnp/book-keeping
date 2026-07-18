-- Login brute-force protection (hobby-release spec): fixed 15-min window per identifier.
CREATE TABLE login_attempts (
  identifier text PRIMARY KEY,
  window_start timestamptz NOT NULL,
  fail_count int NOT NULL DEFAULT 0
);

GRANT SELECT, INSERT, UPDATE, DELETE ON login_attempts TO bookkeeping_app;
