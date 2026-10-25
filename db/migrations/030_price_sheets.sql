-- 030: catalogue inventory and prices (Release A, C2). A developer's price sheet is uploaded per project and previewed
-- (new, changed, no longer listed, invalid) before anything is saved; applied sheets stay as the dated price lists.
-- Every price change of a unit is kept (listing_prices), so "it was 9.2M last month" can be answered and deals keep
-- the price agreed at signing. Announced increases ("+7% from 1 November") apply on their date. Inside a project the
-- developer's unit code is unique (C3: it decides what is the same unit).
CREATE TABLE IF NOT EXISTS price_sheets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id uuid NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  uploaded_by uuid REFERENCES brokers(id) ON DELETE SET NULL,
  file_name text CHECK (file_name IS NULL OR length(file_name) <= 200),
  status text NOT NULL DEFAULT 'preview' CHECK (status IN ('preview', 'applied', 'discarded')),
  entries jsonb NOT NULL DEFAULT '[]'::jsonb,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_price_sheets_project ON price_sheets (project_id, created_at DESC);
ALTER TABLE price_sheets ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS listing_prices (
  id bigserial PRIMARY KEY,
  agency_id uuid NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  listing_id uuid NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  price numeric(14,0) NOT NULL CHECK (price > 0),
  source text NOT NULL CHECK (source IN ('sheet', 'increase', 'edit', 'quick')),
  sheet_id uuid REFERENCES price_sheets(id) ON DELETE SET NULL,
  changed_by uuid REFERENCES brokers(id) ON DELETE SET NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_listing_prices_listing ON listing_prices (listing_id, changed_at DESC);
ALTER TABLE listing_prices ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS price_increases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id uuid NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  phase_id uuid REFERENCES project_phases(id) ON DELETE CASCADE,
  pct numeric(5,2) NOT NULL CHECK (pct BETWEEN -50 AND 100 AND pct <> 0),
  effective_on date NOT NULL,
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'applied', 'cancelled')),
  units integer,
  created_by uuid REFERENCES brokers(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_price_increases_due ON price_increases (effective_on) WHERE status = 'scheduled';
ALTER TABLE price_increases ENABLE ROW LEVEL SECURITY;

ALTER TABLE projects ADD COLUMN IF NOT EXISTS stale_reminded_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS uq_listings_project_dev_code ON listings (project_id, upper(btrim(developer_unit_code)))
  WHERE project_id IS NOT NULL AND developer_unit_code IS NOT NULL AND btrim(developer_unit_code) <> '';
