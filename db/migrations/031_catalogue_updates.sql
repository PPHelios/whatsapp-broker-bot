-- 031: smart quick updates to the catalogue (Release A, C4). A manager says one change by text or voice ("7% increase
-- on Badya from next month", "B12-304 sold", "new plan 5% down 8 years on Badya"); it is read into a preview card
-- (unit count and an example) and only then applied. Each applied change keeps what it replaced, so Undo restores it
-- (for 24 hours, and only where nothing changed since).
CREATE TABLE IF NOT EXISTS catalogue_updates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id uuid NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  created_by uuid REFERENCES brokers(id) ON DELETE SET NULL,
  channel text NOT NULL CHECK (channel IN ('web', 'bot')),
  input text NOT NULL CHECK (length(input) <= 1000),
  action text NOT NULL CHECK (action IN ('increase', 'status', 'price', 'plan')),
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  units integer NOT NULL DEFAULT 0,
  example jsonb,
  status text NOT NULL DEFAULT 'preview' CHECK (status IN ('preview', 'applied', 'undone', 'discarded')),
  undo jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  undone_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_catalogue_updates_agency ON catalogue_updates (agency_id, created_at DESC);
ALTER TABLE catalogue_updates ENABLE ROW LEVEL SECURITY;
