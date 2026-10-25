-- 015: buyer requests and match alerts (Release 3 step 7). A lead's request is a saved search with lead_id
-- (up to 3 per lead, services/leadRequests.js); the match sweep (scheduler) records each unit that newly fits a
-- request once in lead_matches and alerts the lead's broker, grouped. A share link may carry the lead it was
-- sent to (for "send to client" and the hot-client signal); the public page never shows anything of the lead.
ALTER TABLE saved_searches ADD COLUMN IF NOT EXISTS lead_id uuid REFERENCES leads(id) ON DELETE CASCADE;
ALTER TABLE saved_searches ADD COLUMN IF NOT EXISTS alerts_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE saved_searches ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS idx_saved_searches_lead ON saved_searches (agency_id, lead_id) WHERE lead_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_saved_searches_alerts ON saved_searches (agency_id) WHERE alerts_enabled;

CREATE TABLE IF NOT EXISTS lead_matches (
  id bigserial PRIMARY KEY,
  agency_id uuid NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  search_id uuid NOT NULL REFERENCES saved_searches(id) ON DELETE CASCADE,
  listing_id uuid NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  -- new: matched when the request was saved (shown, never alerted); alerted: the sweep told the broker;
  -- sent_to_client: the broker sent it from "send to client"; dismissed: the broker said not for this client.
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'alerted', 'sent_to_client', 'dismissed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  alerted_at timestamptz,
  UNIQUE (search_id, listing_id)
);
CREATE INDEX IF NOT EXISTS idx_lead_matches_listing ON lead_matches (agency_id, listing_id);
CREATE INDEX IF NOT EXISTS idx_lead_matches_lead ON lead_matches (lead_id, created_at DESC);
ALTER TABLE lead_matches ENABLE ROW LEVEL SECURITY;

ALTER TABLE share_links ADD COLUMN IF NOT EXISTS lead_id uuid REFERENCES leads(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_share_links_lead ON share_links (lead_id) WHERE lead_id IS NOT NULL;
