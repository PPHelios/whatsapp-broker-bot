-- 019: Telegram as the brokers' bot channel (Release 3T). A broker links one Telegram account (a one-time start
-- link from onboarding, or sharing their own number); replies and alerts then go to that chat. Button ids longer
-- than Telegram's 64-byte callback_data are kept here under a short token.
ALTER TABLE brokers ADD COLUMN IF NOT EXISTS telegram_user_id bigint;
ALTER TABLE brokers ADD COLUMN IF NOT EXISTS telegram_chat_id bigint;
ALTER TABLE brokers ADD COLUMN IF NOT EXISTS telegram_linked_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS brokers_telegram_user_uidx ON brokers (telegram_user_id) WHERE telegram_user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS telegram_link_tokens (
  token_hash text PRIMARY KEY,
  broker_id uuid NOT NULL REFERENCES brokers(id) ON DELETE CASCADE,
  agency_id uuid NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE INDEX IF NOT EXISTS telegram_link_tokens_broker_idx ON telegram_link_tokens (broker_id);

CREATE TABLE IF NOT EXISTS telegram_callbacks (
  token text PRIMARY KEY,
  data text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS telegram_callbacks_created_idx ON telegram_callbacks (created_at);

ALTER TABLE telegram_link_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE telegram_callbacks ENABLE ROW LEVEL SECURITY;
