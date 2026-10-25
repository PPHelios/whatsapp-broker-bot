-- 021: the "still available?" check (6.3). The unit-check job (services/unitChecks.js) asks a unit's broker once when
-- nobody has vouched for it (confirmed_at) in 21 days, stamping stale_asked_at, and archives it at 30 days if still
-- nobody has (stale_hidden_at; the broker's one tap on "Still available" brings it back). Any edit or quick update
-- sets confirmed_at again, which makes the old stamps stale (they only count while newer than confirmed_at).
ALTER TABLE listings ADD COLUMN IF NOT EXISTS stale_asked_at timestamptz;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS stale_hidden_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_listings_unit_check ON listings (agency_id, confirmed_at) WHERE status = 'active';
