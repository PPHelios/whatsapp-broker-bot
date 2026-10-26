-- 038: the assistant (Release B, C10 project assistant + N1 own-data assistant). Brokers ask in words or by voice; it
-- answers only from the agency's stored data with the date of that data, and says "not in our data" otherwise.
-- project_contexts keeps each project's context (a summary and structured facts: developer, location, delivery,
-- phases, plans, prices by type, materials, highlights, brochure facts), rebuilt whenever the project, its prices,
-- units or brochure change (source_key). assistant_questions logs each question (what was asked, answered or not,
-- web used) so managers see what brokers needed. Web search is off until the app owner switches it on per agency
-- (agencies.assistant: web, web_month), and every web answer is labelled unverified with its source links.
CREATE TABLE IF NOT EXISTS project_contexts (
  project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  agency_id uuid NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  summary text NOT NULL DEFAULT '',
  facts jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_key text NOT NULL,
  built_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE project_contexts ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS assistant_questions (
  id bigserial PRIMARY KEY,
  agency_id uuid NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  broker_id uuid REFERENCES brokers(id) ON DELETE SET NULL,
  question text NOT NULL CHECK (length(question) <= 600),
  channel text NOT NULL DEFAULT 'web' CHECK (channel IN ('web', 'telegram', 'whatsapp')),
  found boolean NOT NULL DEFAULT false,
  web boolean NOT NULL DEFAULT false,
  scopes text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE assistant_questions ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_assistant_questions_agency ON assistant_questions (agency_id, created_at DESC);

ALTER TABLE agencies ADD COLUMN IF NOT EXISTS assistant jsonb NOT NULL DEFAULT '{}'::jsonb;
