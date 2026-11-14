-- 112: the map link a broker typed when adding a new compound, kept on its pending name until the owner reviews it.
-- Roll back: ALTER TABLE place_names DROP COLUMN pin_link;
ALTER TABLE place_names ADD COLUMN IF NOT EXISTS pin_link text;
