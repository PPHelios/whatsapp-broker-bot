-- 009: client share links for public unit pages (/<agency-slug>/<unit-code>?s=<token>). The token is
-- stored only as a SHA-256 hash; each link remembers who shared it, for the "client opened" alert.
CREATE TABLE IF NOT EXISTS share_links (
  token_hash text PRIMARY KEY,
  agency_id uuid NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  listing_id uuid NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  broker_id uuid REFERENCES brokers(id) ON DELETE SET NULL,
  channel text NOT NULL CHECK (channel IN ('whatsapp', 'web')),
  lang text NOT NULL DEFAULT 'ar' CHECK (lang IN ('ar', 'en')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + INTERVAL '180 days',
  revoked_at timestamptz,
  open_count integer NOT NULL DEFAULT 0,
  first_opened_at timestamptz,
  last_opened_at timestamptz,
  last_alert_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_share_links_listing ON share_links (agency_id, listing_id, created_at DESC);
