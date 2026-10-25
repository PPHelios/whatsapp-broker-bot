-- 020: production errors and broker bug reports (lib/errorReports.js). One row per caught error (kind 'error':
-- bot turns, web pages, background jobs, process crashes, browser scripts) or per report a broker sends with
-- *bug …* or the website's "Report a problem" page (kind 'report'). The owner gets a Telegram alert per new
-- fingerprint at most every 30 minutes (alerted_at). Phone numbers are masked before the text is stored, and
-- the privacy job deletes rows after 90 days.
CREATE TABLE IF NOT EXISTS error_events (
  id bigserial PRIMARY KEY,
  kind text NOT NULL DEFAULT 'error' CHECK (kind IN ('error', 'report')),
  source text NOT NULL,
  fingerprint text NOT NULL,
  message text NOT NULL,
  stack text,
  agency_id uuid REFERENCES agencies(id) ON DELETE SET NULL,
  broker_id uuid REFERENCES brokers(id) ON DELETE SET NULL,
  msg_id text,
  path text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  alerted_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS error_events_recent ON error_events (created_at DESC);
CREATE INDEX IF NOT EXISTS error_events_fingerprint ON error_events (fingerprint, created_at DESC);
ALTER TABLE error_events ENABLE ROW LEVEL SECURITY;
