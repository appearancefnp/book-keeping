CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES firms(id),
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  totp_secret text NOT NULL,
  role text NOT NULL CHECK (role IN ('firm_admin','accountant','owner','employee')),
  language text NOT NULL DEFAULT 'lv' CHECK (language IN ('lv','ru','en')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  token text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

-- Users/sessions are firm-level auth data, administered on the app pool (not client-tenant RLS).
GRANT SELECT, INSERT, UPDATE, DELETE ON sessions TO bookkeeping_app;
GRANT SELECT, INSERT, UPDATE ON users TO bookkeeping_app;
