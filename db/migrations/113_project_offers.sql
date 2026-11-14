-- Ask answers from a project's offers (area, price, down payment, installment) as real rows, so every filter is exact SQL
-- and 300+ projects stay fast. The rows are read from the project's notes whenever the notes change (source 'notes'); the
-- notes stay the text a broker edits. projects.offers_hash is the hash of the notes the rows were read from.
CREATE TABLE IF NOT EXISTS project_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  area numeric,
  floor text,
  bedrooms smallint,
  price numeric NOT NULL,
  down numeric,
  monthly numeric,
  monthly_est numeric,
  years smallint,
  raw text,
  source text NOT NULL DEFAULT 'notes',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS project_offers_project_idx ON project_offers (agency_id, project_id);
CREATE INDEX IF NOT EXISTS project_offers_area_idx ON project_offers (agency_id, area);
CREATE INDEX IF NOT EXISTS project_offers_price_idx ON project_offers (agency_id, price);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS offers_hash text;
ALTER TABLE project_offers ENABLE ROW LEVEL SECURITY;
