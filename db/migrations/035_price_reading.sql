-- 035: reading PDF and photographed price lists with AI (Release B, C5). Off for every agency until the app owner
-- switches it on with a monthly page allowance (agencies.price_reading). A page read once is kept by its fingerprint
-- (price_page_reads, shared by all agencies: developer price lists are public material) so the same page uploaded
-- again, by anyone, costs no AI call and no allowance. price_read_log counts each agency's pages per month.
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS price_reading jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS price_page_reads (
  fingerprint text PRIMARY KEY CHECK (length(fingerprint) <= 120),
  rows jsonb NOT NULL DEFAULT '[]'::jsonb,
  model text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE price_page_reads ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS price_read_log (
  id bigserial PRIMARY KEY,
  agency_id uuid NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  broker_id uuid REFERENCES brokers(id) ON DELETE SET NULL,
  fingerprint text NOT NULL,
  reused boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE price_read_log ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_price_read_log_agency ON price_read_log (agency_id, created_at);

ALTER TABLE price_sheets ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'file' CHECK (source IN ('file', 'ai'));
