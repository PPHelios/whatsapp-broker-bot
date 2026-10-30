-- 055: "Needs manager". A broker flags a lead for a manager with a note; each lead holds one open flag. A manager marks it
-- handled (with an optional reply the broker sees on the timeline). Two new timeline event kinds record both steps.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS flagged_at timestamptz;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS flag_note text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS flagged_by uuid REFERENCES brokers(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS leads_flagged ON leads (agency_id, flagged_at) WHERE flagged_at IS NOT NULL;
ALTER TABLE lead_events DROP CONSTRAINT IF EXISTS lead_events_kind_check;
ALTER TABLE lead_events ADD CONSTRAINT lead_events_kind_check CHECK (kind IN ('created', 'inquiry', 'assigned', 'stage', 'note', 'contacted', 'follow_up_set', 'follow_up_done',
  'request_set', 'match_sent', 'share_opened', 'deal', 'exported', 'merged', 'undo', 'flag', 'flag_handled'));
