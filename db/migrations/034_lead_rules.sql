-- 034: lead response rules and the team page (Release A, R3). An agency may switch on a rule: a new lead its broker
-- hasn't contacted within N working minutes moves to the next available broker (round robin, longest without a lead
-- first) and the managers are told. assigned_at stamps every assignment, response_due_at is the deadline (set only
-- while the rule is on), response_jumps caps how often one lead moves. A broker can be away until a date (no new
-- leads, skipped by round robin, reminders go to the managers); deactivated_at sorts former brokers on the team page.
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS lead_rules jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE brokers ADD COLUMN IF NOT EXISTS away_until timestamptz;
ALTER TABLE brokers ADD COLUMN IF NOT EXISTS deactivated_at timestamptz;
ALTER TABLE brokers ADD COLUMN IF NOT EXISTS last_lead_at timestamptz;
UPDATE brokers SET deactivated_at = coalesce(last_active_at, created_at) WHERE NOT is_active AND deactivated_at IS NULL;

ALTER TABLE leads ADD COLUMN IF NOT EXISTS assigned_at timestamptz;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS response_due_at timestamptz;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS response_jumps integer NOT NULL DEFAULT 0;
UPDATE leads SET assigned_at = created_at WHERE assigned_broker_id IS NOT NULL AND assigned_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_leads_response_due ON leads (response_due_at) WHERE response_due_at IS NOT NULL;

-- A manager's per-broker switch keeps a notification in the inbox only.
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_reason_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_reason_check
  CHECK (reason = ANY (ARRAY['chosen', 'fallback', 'no_credits', 'window_closed', 'quiet_hours', 'merged', 'no_push', 'not_linked', 'switched_off']));
