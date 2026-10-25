-- 011: CRM foundation. agencies.crm_settings holds per-agency CRM options (privacy note, quiet hours);
-- crm_jobs keeps one row per scheduler job: when it last ran, its watermark and its last outcome.
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS crm_settings jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS crm_jobs (
  name text PRIMARY KEY,
  last_started_at timestamptz,
  last_finished_at timestamptz,
  last_status text CHECK (last_status IN ('running', 'success', 'failed')),
  last_error text,
  watermark jsonb NOT NULL DEFAULT '{}'::jsonb,
  run_count integer NOT NULL DEFAULT 0
);
ALTER TABLE crm_jobs ENABLE ROW LEVEL SECURITY;
