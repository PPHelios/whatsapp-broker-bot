-- 027: viewings (phase 2 step 6). A viewing set on a lead: when, which unit, where, and the client's answer from the
-- private link the broker sends on WhatsApp (services/viewings.js). Only the token's hash is kept; the link itself is
-- only in the broker's message. Deleting (erasing) the lead deletes its viewings.
CREATE TABLE IF NOT EXISTS viewings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id uuid NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  broker_id uuid REFERENCES brokers(id) ON DELETE SET NULL,
  listing_id uuid REFERENCES listings(id) ON DELETE SET NULL,
  starts_at timestamptz NOT NULL,
  place text CHECK (place IS NULL OR length(place) <= 200),
  lang text NOT NULL DEFAULT 'ar' CHECK (lang IN ('ar', 'en')),
  token_hash text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'confirmed', 'reschedule', 'cancelled')),
  client_proposed_at timestamptz,
  client_note text CHECK (client_note IS NULL OR length(client_note) <= 300),
  responded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_viewings_lead ON viewings (agency_id, lead_id, created_at DESC);
ALTER TABLE viewings ENABLE ROW LEVEL SECURITY;
