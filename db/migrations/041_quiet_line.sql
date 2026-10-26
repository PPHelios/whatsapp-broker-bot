-- 041: the "60 days since you spoke" line in match alerts (Release B, N3). On by default; each user can switch it off
-- in Settings.
ALTER TABLE brokers ADD COLUMN IF NOT EXISTS quiet_line boolean NOT NULL DEFAULT true;
