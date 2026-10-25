-- 025: plans, manual payments and self sign-up (phase 2 step 4).
-- agencies: the plan paid for and until when, the trial end, pilot agencies (Office, free until the POC ends) and the
-- owner's approval of a self sign-up. The plan in force comes from these (services/billing.js effectivePlan): pilot →
-- Office; paid_until in the future → plan; trial_ends_at in the future → Office; otherwise the small Free plan.
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS plan text NOT NULL DEFAULT 'office';
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS paid_until timestamptz;
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS trial_ends_at timestamptz;
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS pilot boolean NOT NULL DEFAULT false;
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS approval text NOT NULL DEFAULT 'approved';
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS signed_up_at timestamptz;
DO $$ BEGIN
  ALTER TABLE agencies ADD CONSTRAINT agencies_plan_check CHECK (plan IN ('solo', 'office', 'agency', 'free'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE agencies ADD CONSTRAINT agencies_approval_check CHECK (approval IN ('pending', 'approved', 'rejected'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- Every agency that exists today is a pilot.
UPDATE agencies SET pilot = true WHERE signed_up_at IS NULL AND NOT pilot;

-- Owner settings (sign-up switch, InstaPay details), one JSON value per key.
CREATE TABLE IF NOT EXISTS app_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT NOW()
);
ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;

-- A payment an agency announces (InstaPay / bank transfer with its reference) and the owner confirms or cancels.
CREATE TABLE IF NOT EXISTS payments (
  id bigserial PRIMARY KEY,
  agency_id uuid NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('plan', 'voice_pack')),
  plan text CHECK (plan IS NULL OR plan IN ('solo', 'office', 'agency')),
  months integer NOT NULL DEFAULT 1 CHECK (months BETWEEN 1 AND 12),
  amount_egp integer NOT NULL CHECK (amount_egp > 0),
  reference text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'cancelled')),
  requested_by uuid REFERENCES brokers(id) ON DELETE SET NULL,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  CHECK ((kind = 'plan') = (plan IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS payments_agency_idx ON payments (agency_id, created_at DESC);
CREATE INDEX IF NOT EXISTS payments_pending_idx ON payments (created_at) WHERE status = 'pending';
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
