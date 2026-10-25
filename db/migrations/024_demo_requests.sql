-- 024: "Try it with your agency" requests from the landing page (phase 2 step 3). The owner is alerted on Telegram and
-- sees the latest on /app/owner; the phone is kept only to call them back.
CREATE TABLE IF NOT EXISTS demo_requests (
  id bigserial PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  agency_name text CHECK (agency_name IS NULL OR length(agency_name) <= 120),
  phone_e164 text NOT NULL CHECK (length(phone_e164) <= 20),
  team_size integer CHECK (team_size IS NULL OR team_size BETWEEN 1 AND 1000),
  lang text CHECK (lang IS NULL OR lang IN ('ar', 'en')),
  created_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS demo_requests_created_idx ON demo_requests (created_at DESC);
ALTER TABLE demo_requests ENABLE ROW LEVEL SECURITY;
