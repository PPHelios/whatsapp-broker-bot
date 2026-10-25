-- 012: the notification centre and message credits (Release 3 step 2).
-- notifications: every alert a broker gets, one row per (broker, event). The row is the website inbox
-- (always, silently) and the delivery record: which channel carried it and why.
CREATE TABLE IF NOT EXISTS notifications (
  id bigserial PRIMARY KEY,
  agency_id uuid NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  broker_id uuid NOT NULL REFERENCES brokers(id) ON DELETE CASCADE,
  kind text NOT NULL,
  dedupe_key text NOT NULL,
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  url text CHECK (url IS NULL OR url LIKE '/app/%'),
  lead_id uuid,
  listing_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  -- Delivery: whatsapp | webpush | inbox (nothing pushed; the inbox holds it).
  channel text CHECK (channel IN ('whatsapp', 'webpush', 'inbox')),
  reason text CHECK (reason IN ('chosen', 'fallback', 'no_credits', 'window_closed', 'quiet_hours', 'merged', 'no_push')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'held', 'queued', 'sent', 'failed', 'skipped')),
  deliver_after timestamptz,
  delivered_at timestamptz,
  merged_into bigint REFERENCES notifications(id) ON DELETE SET NULL,
  UNIQUE (broker_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS idx_notifications_inbox ON notifications (broker_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications (broker_id) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_notifications_due ON notifications (deliver_after) WHERE status IN ('held', 'queued');
CREATE INDEX IF NOT EXISTS idx_notifications_agency ON notifications (agency_id, created_at DESC);
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

-- Web push subscriptions, tied to the signed-in broker (removed on 404/410 or deactivation).
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id bigserial PRIMARY KEY,
  broker_id uuid NOT NULL REFERENCES brokers(id) ON DELETE CASCADE,
  agency_id uuid NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  endpoint text NOT NULL UNIQUE CHECK (endpoint LIKE 'https://%'),
  p256dh text NOT NULL,
  auth text NOT NULL,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_ok_at timestamptz,
  failed_count integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_broker ON push_subscriptions (broker_id);
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

-- Per-kind channel (whatsapp | web) and quiet hours; empty = WhatsApp for every kind, 22:00–08:00.
ALTER TABLE brokers ADD COLUMN IF NOT EXISTS notify_prefs jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Message credits per agency (NULL = the server default) and optional per-broker caps (NULL = off).
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS wa_credits_monthly integer CHECK (wa_credits_monthly IS NULL OR wa_credits_monthly >= 0);
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS wa_broker_daily_cap integer CHECK (wa_broker_daily_cap IS NULL OR wa_broker_daily_cap > 0);
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS wa_broker_weekly_cap integer CHECK (wa_broker_weekly_cap IS NULL OR wa_broker_weekly_cap > 0);

-- Credit checks count this month's sends per agency and per broker.
CREATE INDEX IF NOT EXISTS idx_operation_logs_wa_outbound ON operation_logs (created_at, agency_id, broker_id) WHERE operation_type = 'wa_outbound';
