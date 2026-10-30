-- 048: F23 a project's photo gallery. Shared images (renders, amenities, master plan) show on every unit of the
-- project (client page, flyer); a layout image or PDF page is read by AI (type, area, bedrooms, label) and attached to
-- the matching units (listing_ids). Unsure matches wait for a manager (match_status 'unsure').
CREATE TABLE IF NOT EXISTS project_images (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id uuid NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  url text NOT NULL,
  storage_path text,
  mime text NOT NULL DEFAULT 'image/jpeg',
  role text NOT NULL DEFAULT 'shared' CHECK (role IN ('shared', 'layout', 'hidden')),
  kind text NOT NULL DEFAULT 'other',
  layout jsonb NOT NULL DEFAULT '{}'::jsonb,
  match_status text CHECK (match_status IN ('matched', 'unsure', 'manual')),
  listing_ids uuid[] NOT NULL DEFAULT '{}',
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS project_images_project_idx ON project_images (project_id, position);
CREATE INDEX IF NOT EXISTS project_images_listings_idx ON project_images USING gin (listing_ids);
ALTER TABLE project_images ENABLE ROW LEVEL SECURITY;
