-- 110: extra facts on places, all optional. areas: kind of place, governorate (an attribute, not a tree level), shared-name
-- note, Google id. map_places: Google id and the project note (en/ar, with where it came from).
-- Roll back: ALTER TABLE areas DROP COLUMN place_type, DROP COLUMN governorate, DROP COLUMN disambiguation_note, DROP COLUMN google_place_id;
-- ALTER TABLE map_places DROP COLUMN google_place_id, DROP COLUMN project_info_en, DROP COLUMN project_info_ar, DROP COLUMN project_info_source;
ALTER TABLE areas ADD COLUMN IF NOT EXISTS place_type text CHECK (place_type IS NULL OR place_type IN ('city_or_district', 'sub_area_or_sector', 'neighborhood_or_zone', 'road_or_corridor'));
ALTER TABLE areas ADD COLUMN IF NOT EXISTS governorate text;
ALTER TABLE areas ADD COLUMN IF NOT EXISTS disambiguation_note text;
ALTER TABLE areas ADD COLUMN IF NOT EXISTS google_place_id text;
ALTER TABLE map_places ADD COLUMN IF NOT EXISTS google_place_id text;
ALTER TABLE map_places ADD COLUMN IF NOT EXISTS project_info_en text;
ALTER TABLE map_places ADD COLUMN IF NOT EXISTS project_info_ar text;
ALTER TABLE map_places ADD COLUMN IF NOT EXISTS project_info_source text;
