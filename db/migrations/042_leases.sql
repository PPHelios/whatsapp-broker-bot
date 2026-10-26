-- 042: rental renewals (Release B, N4). Opt-in per rented unit: the broker enters the lease start, length (months),
-- rent and yearly increase, and ticks "remind me". Reminders go to that broker 60 and 30 days before the lease ends
-- (renew or re-list) and 30 days before each yearly increase; managers see the lease ends of the next 90 days on
-- the agency dashboard. reminded holds the reminder keys already sent (end60, end30, inc1, inc2…).
CREATE TABLE IF NOT EXISTS leases (
  id bigserial PRIMARY KEY,
  agency_id uuid NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  listing_id uuid NOT NULL UNIQUE REFERENCES listings(id) ON DELETE CASCADE,
  broker_id uuid REFERENCES brokers(id) ON DELETE SET NULL,
  tenant_name text CHECK (tenant_name IS NULL OR length(tenant_name) <= 120),
  start_date date NOT NULL,
  months smallint NOT NULL CHECK (months BETWEEN 1 AND 120),
  rent numeric(14,2) CHECK (rent IS NULL OR rent >= 0),
  increase_pct numeric(5,2) CHECK (increase_pct IS NULL OR increase_pct BETWEEN 0 AND 100),
  remind boolean NOT NULL DEFAULT false,
  reminded text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_leases_agency ON leases (agency_id);
ALTER TABLE leases ENABLE ROW LEVEL SECURITY;
