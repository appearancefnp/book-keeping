-- Single-use TOTP: record the last accepted time-step per user so a code cannot
-- be replayed within its ±1 verification window. login() checks-and-updates this
-- atomically under a row lock (SELECT ... FOR UPDATE). NULL means no code has been
-- accepted yet, so any first login is allowed.
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_totp_step bigint;

-- bookkeeping_app already holds UPDATE on users (migration 017), so the app can
-- write this column; no new grant is required.
