-- 022: more alerts (6.5). lead_matches.alerted_price is the unit's price when its broker last heard about it, so the
-- match sweep can tell them once more when the price later drops by 2% or more (services/matchSweep.js); existing rows
-- start at the unit's current price. leads.interest_nudged_at marks the one "interested but no follow-up" nudge per
-- quiet spell (services/followUpReminders.js): it counts only while newer than last_activity_at.
ALTER TABLE lead_matches ADD COLUMN IF NOT EXISTS alerted_price numeric(14, 0);
UPDATE lead_matches m SET alerted_price = l.price_value FROM listings l WHERE l.id = m.listing_id AND m.alerted_price IS NULL;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS interest_nudged_at timestamptz;
