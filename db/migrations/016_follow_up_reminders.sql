-- 016: follow-up reminders and the 24-hour nudge (Release 3 step 8). The reminder job (services/followUpReminders.js)
-- claims due follow-ups with FOR UPDATE SKIP LOCKED and stamps follow_up_reminded_at, so two instances never remind
-- twice; setting, postponing or reassigning a follow-up clears it. nudged_at marks the one "not contacted for 24
-- hours" nudge of a new lead.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS follow_up_reminded_at timestamptz;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS nudged_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_leads_untouched ON leads (created_at) WHERE stage = 'new' AND last_contact_at IS NULL AND nudged_at IS NULL;
