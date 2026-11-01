-- 059: owner profiles are secret data. A private flag on each profile: owner phones and details are
-- shown only after a manager approves the request (the same rule as other private data). Default true, so
-- every profile created from now on is private unless a manager clears it.
ALTER TABLE unit_owners ADD COLUMN IF NOT EXISTS is_private boolean NOT NULL DEFAULT true;
