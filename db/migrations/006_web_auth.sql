-- 006: web sign-in — magic-link tokens and sessions (stored as SHA-256 hashes only) and rate-limit windows.

CREATE TABLE IF NOT EXISTS web_login_tokens (
  token_hash text PRIMARY KEY,
  broker_id uuid NOT NULL REFERENCES brokers(id) ON DELETE CASCADE,
  agency_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN ('whatsapp', 'web')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_web_login_tokens_broker ON web_login_tokens (broker_id, created_at DESC);

CREATE TABLE IF NOT EXISTS web_sessions (
  id_hash text PRIMARY KEY,
  broker_id uuid NOT NULL REFERENCES brokers(id) ON DELETE CASCADE,
  agency_id uuid NOT NULL,
  csrf_token text NOT NULL,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_web_sessions_broker ON web_sessions (broker_id);

-- Fixed-window counters shared by every pod (login requests, link confirms, public page opens, ...).
CREATE TABLE IF NOT EXISTS web_rate_limits (
  bucket text NOT NULL,
  window_start timestamptz NOT NULL,
  hits integer NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);
