-- Invite-based provisioning + 2FA enrolment (hobby-release spec).
ALTER TABLE users ADD COLUMN status text NOT NULL DEFAULT 'active'
  CHECK (status IN ('invited', 'active'));

CREATE TABLE user_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON user_invites TO bookkeeping_app;
