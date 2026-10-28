-- 045: per-agency lead intake (next picks L1, L7). Each intake is a secret URL (only its SHA-256 is stored) that a
-- form or automation (Make.com: Facebook/Instagram lead ads) posts leads to; leads get the intake's source and go
-- round robin. Every request is logged (no phone, only its last 4 digits); an intake that goes quiet alerts once.
CREATE TABLE IF NOT EXISTS lead_intakes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id uuid NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  source text NOT NULL CHECK (length(source) BETWEEN 1 AND 60),
  token_hash text NOT NULL UNIQUE,
  token_hint text NOT NULL,
  quiet_days smallint NOT NULL DEFAULT 3 CHECK (quiet_days BETWEEN 1 AND 60),
  last_lead_at timestamptz,
  quiet_alerted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS lead_intakes_agency_idx ON lead_intakes (agency_id);

CREATE TABLE IF NOT EXISTS lead_intake_log (
  id bigserial PRIMARY KEY,
  intake_id uuid NOT NULL REFERENCES lead_intakes(id) ON DELETE CASCADE,
  agency_id uuid NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  received_at timestamptz NOT NULL DEFAULT now(),
  outcome text NOT NULL CHECK (outcome IN ('created', 'merged', 'colleague', 'repeat', 'erased_before', 'invalid', 'test', 'error')),
  external_id text,
  lead_id uuid REFERENCES leads(id) ON DELETE SET NULL,
  phone_tail text,
  detail text
);
CREATE INDEX IF NOT EXISTS lead_intake_log_intake_idx ON lead_intake_log (intake_id, received_at DESC);
CREATE INDEX IF NOT EXISTS lead_intake_log_agency_idx ON lead_intake_log (agency_id, received_at DESC);
-- The same lead sent twice (Make retries) is taken once.
CREATE UNIQUE INDEX IF NOT EXISTS lead_intake_log_external_idx ON lead_intake_log (intake_id, external_id)
  WHERE external_id IS NOT NULL AND outcome IN ('created', 'merged', 'colleague');

ALTER TABLE lead_intakes ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_intake_log ENABLE ROW LEVEL SECURITY;
