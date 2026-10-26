-- 032: client comparisons (Release A, C7). A broker sends one link that compares 2 or 3 of the agency's units side by
-- side (price, area, price per m², plans, delivery); the page shows only the client-safe facts. The token is stored
-- hashed, like share links; opens are counted and alert the broker who sent it.
CREATE TABLE IF NOT EXISTS compare_links (
  token_hash text PRIMARY KEY,
  agency_id uuid NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  broker_id uuid REFERENCES brokers(id) ON DELETE SET NULL,
  listing_ids uuid[] NOT NULL CHECK (cardinality(listing_ids) BETWEEN 2 AND 3),
  lang text NOT NULL DEFAULT 'ar' CHECK (lang IN ('ar', 'en')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '180 days'),
  revoked_at timestamptz,
  open_count integer NOT NULL DEFAULT 0,
  last_opened_at timestamptz,
  last_alert_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_compare_links_broker ON compare_links (broker_id, created_at DESC);
ALTER TABLE compare_links ENABLE ROW LEVEL SECURITY;
