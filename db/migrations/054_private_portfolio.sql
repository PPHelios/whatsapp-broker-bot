-- 054: the agency owner's private portfolio. A private unit or lead is invisible to brokers and managers on every
-- surface (lib/visibility.js); only the agency owner sees and sets it. It still counts toward plan limits.
ALTER TABLE listings ADD COLUMN IF NOT EXISTS is_private boolean NOT NULL DEFAULT false;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS is_private boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS listings_private ON listings (agency_id) WHERE is_private;
CREATE INDEX IF NOT EXISTS leads_private ON leads (agency_id) WHERE is_private;
