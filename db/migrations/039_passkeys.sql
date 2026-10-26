-- 039: passkey sign-in (Release B, R6). Off for each user until they switch it on in Settings; then they add a
-- passkey on each device (fingerprint, face or screen lock) and sign in with it, with no link from the bot.
-- Switching it off removes the user's passkeys. Only the public key is stored (SPKI, base64url), with the
-- signature counter. passkey_challenges holds one-time challenges for 5 minutes (registration or sign-in).
ALTER TABLE brokers ADD COLUMN IF NOT EXISTS passkey_enabled boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS broker_passkeys (
  id bigserial PRIMARY KEY,
  broker_id uuid NOT NULL REFERENCES brokers(id) ON DELETE CASCADE,
  agency_id uuid NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  credential_id text NOT NULL UNIQUE CHECK (length(credential_id) BETWEEN 16 AND 1400),
  public_key text NOT NULL,
  alg integer NOT NULL CHECK (alg IN (-7, -257)),
  sign_count bigint NOT NULL DEFAULT 0,
  label text CHECK (label IS NULL OR length(label) <= 120),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_broker_passkeys_broker ON broker_passkeys (broker_id);
ALTER TABLE broker_passkeys ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS passkey_challenges (
  challenge text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('register', 'login')),
  broker_id uuid REFERENCES brokers(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_passkey_challenges_expiry ON passkey_challenges (expires_at);
ALTER TABLE passkey_challenges ENABLE ROW LEVEL SECURITY;
