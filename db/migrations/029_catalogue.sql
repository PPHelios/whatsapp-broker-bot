-- 029: the developer catalogue (Release A, C1). Per agency: developers (their sales contact is internal only),
-- projects (compound or launch) with phases, payment plans with extra fees, and materials as links, each client-visible
-- or internal, checked once a week (services/catalogue.js). A project's units stay ordinary listings
-- (listings.project_id, listings.phase_id), so search, alerts, client links and flyers keep working.
CREATE TABLE IF NOT EXISTS developers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id uuid NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  name_en text CHECK (name_en IS NULL OR length(name_en) <= 120),
  contact_name text CHECK (contact_name IS NULL OR length(contact_name) <= 120),
  contact_phone text CHECK (contact_phone IS NULL OR length(contact_phone) <= 30),
  notes text CHECK (notes IS NULL OR length(notes) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_developers_agency_name ON developers (agency_id, lower(btrim(name)));
ALTER TABLE developers ENABLE ROW LEVEL SECURITY;

ALTER TABLE projects ADD COLUMN IF NOT EXISTS developer_id uuid REFERENCES developers(id) ON DELETE SET NULL;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS name_en text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'selling';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS delivery_quarter smallint;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS delivery_raw text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS notes text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS prices_updated_at timestamptz;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS archived_at timestamptz;
-- Never an invented maintenance %: unknown stays NULL.
ALTER TABLE projects ALTER COLUMN maintenance_pct DROP DEFAULT;
DO $$ BEGIN
  ALTER TABLE projects ADD CONSTRAINT projects_status_check CHECK (status IN ('launching', 'selling', 'sold_out'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE projects ADD CONSTRAINT projects_delivery_quarter_check CHECK (delivery_quarter IS NULL OR delivery_quarter BETWEEN 1 AND 4);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- Project names are unique per agency whatever the case ("Badya" and "badya" are one project).
CREATE UNIQUE INDEX IF NOT EXISTS uq_projects_agency_lower_name ON projects (agency_id, lower(btrim(name)));
CREATE INDEX IF NOT EXISTS idx_projects_developer ON projects (agency_id, developer_id);
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS project_phases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id uuid NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  delivery_year smallint CHECK (delivery_year IS NULL OR delivery_year BETWEEN 2000 AND 2100),
  delivery_quarter smallint CHECK (delivery_quarter IS NULL OR delivery_quarter BETWEEN 1 AND 4),
  status text NOT NULL DEFAULT 'selling' CHECK (status IN ('launching', 'selling', 'sold_out')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_project_phases_name ON project_phases (project_id, lower(btrim(name)));
ALTER TABLE project_phases ENABLE ROW LEVEL SECURITY;

-- A plan belongs to the project, or to one phase. Milestones: [{ pct, due_after_months, label }];
-- extra fees: [{ label, amount }] (club membership, parking…), in EGP.
CREATE TABLE IF NOT EXISTS project_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id uuid NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  phase_id uuid REFERENCES project_phases(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  down_payment_pct numeric(5,2) NOT NULL CHECK (down_payment_pct BETWEEN 0 AND 100),
  years numeric(4,1) NOT NULL DEFAULT 0 CHECK (years BETWEEN 0 AND 20),
  frequency text NOT NULL DEFAULT 'quarterly' CHECK (frequency IN ('monthly', 'quarterly', 'semi_annual', 'annual')),
  discount_pct numeric(5,2) NOT NULL DEFAULT 0 CHECK (discount_pct BETWEEN 0 AND 100),
  milestones jsonb NOT NULL DEFAULT '[]'::jsonb,
  maintenance_pct numeric(5,2) CHECK (maintenance_pct IS NULL OR maintenance_pct BETWEEN 0 AND 30),
  maintenance_due text CHECK (maintenance_due IS NULL OR maintenance_due IN ('delivery', 'installments', 'contract')),
  maintenance_splits smallint CHECK (maintenance_splits IS NULL OR maintenance_splits BETWEEN 1 AND 12),
  extra_fees jsonb NOT NULL DEFAULT '[]'::jsonb,
  position smallint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_project_plans_project ON project_plans (project_id, position);
ALTER TABLE project_plans ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS project_materials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id uuid NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'other' CHECK (kind IN ('master_plan', 'brochure', 'layout', 'video', 'location', 'website', 'price_sheet', 'other')),
  label text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 80),
  url text NOT NULL CHECK (url ~ '^https?://' AND length(url) <= 1000),
  unit_type text CHECK (unit_type IS NULL OR length(unit_type) <= 60),
  client_visible boolean NOT NULL DEFAULT false,
  check_status text CHECK (check_status IS NULL OR check_status IN ('ok', 'broken')),
  checked_at timestamptz,
  broken_since timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_project_materials_project ON project_materials (project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_project_materials_check ON project_materials (checked_at NULLS FIRST);
ALTER TABLE project_materials ENABLE ROW LEVEL SECURITY;

ALTER TABLE listings ADD COLUMN IF NOT EXISTS phase_id uuid REFERENCES project_phases(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_listings_project ON listings (project_id) WHERE project_id IS NOT NULL;
