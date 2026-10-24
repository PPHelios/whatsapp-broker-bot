-- 007: saved web searches (per broker, agency-scoped). seen_ids remembers the results already seen,
-- so the list can say how many units are new. Release 3 adds lead_id (buyer requests).
CREATE TABLE IF NOT EXISTS saved_searches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id uuid NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  broker_id uuid NOT NULL REFERENCES brokers(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  filters jsonb NOT NULL,
  seen_ids uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_run_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_saved_searches_broker ON saved_searches (agency_id, broker_id, created_at DESC);
