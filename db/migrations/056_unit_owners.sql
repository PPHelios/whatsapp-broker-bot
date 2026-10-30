-- 056: unit owner profiles. A person who has a unit to sell or rent is a profile of the agency, separate from leads
-- (a lead wants to buy or rent). Merged by phone across the agency; a unit points to its owner. Free-text notes and a flag
-- that managers edit; every change goes into unit_owner_events (creation, notes, flag, units linked and moved).
CREATE TABLE IF NOT EXISTS unit_owners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id uuid NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  name text,
  phones text[] NOT NULL DEFAULT '{}',
  notes text,
  flag text,
  created_by uuid REFERENCES brokers(id) ON DELETE SET NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS unit_owners_phones ON unit_owners USING gin (phones);
CREATE INDEX IF NOT EXISTS unit_owners_agency ON unit_owners (agency_id, created_at DESC);
ALTER TABLE listings ADD COLUMN IF NOT EXISTS owner_id uuid REFERENCES unit_owners(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS listings_owner ON listings (owner_id) WHERE owner_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS unit_owner_events (
  id bigserial PRIMARY KEY,
  agency_id uuid NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES unit_owners(id) ON DELETE CASCADE,
  broker_id uuid REFERENCES brokers(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('created', 'edited', 'note', 'flag', 'unit_linked', 'unit_moved_in', 'unit_moved_out')),
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS unit_owner_events_owner ON unit_owner_events (owner_id, created_at DESC, id DESC);
ALTER TABLE unit_owners ENABLE ROW LEVEL SECURITY;
ALTER TABLE unit_owner_events ENABLE ROW LEVEL SECURITY;
