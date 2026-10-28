-- 052: agency-only unit location and secret details. A unit's pin stays in listings.lat/lng (its unit number and
-- address in details); a catalogue project gets its own pin that its units inherit. agencies.crm_settings.secret_details
-- = 'restricted' (default: the unit's broker and managers) or 'all' (every broker in the agency). A broker who may
-- not see them asks; the unit's broker or a manager answers, and both steps are logged.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS lat double precision;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS lng double precision;
CREATE TABLE IF NOT EXISTS unit_access_requests (
  id bigserial PRIMARY KEY,
  agency_id uuid NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  listing_id uuid NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  broker_id uuid NOT NULL REFERENCES brokers(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined')),
  decided_by uuid REFERENCES brokers(id) ON DELETE SET NULL,
  decided_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS unit_access_requests_listing ON unit_access_requests (agency_id, listing_id, broker_id, created_at DESC);
ALTER TABLE unit_access_requests ENABLE ROW LEVEL SECURITY;
