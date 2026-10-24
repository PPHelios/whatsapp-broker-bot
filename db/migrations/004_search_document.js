// 004: one search trigger and one normalizer (D1/D2); bilingual place keys from compound_synonyms.
"use strict";

const { NORMALIZE_SEARCH_SQL } = require("../../domain/searchText");
const { seedVocabulary } = require("../../domain/vocabulary");

const SQL = `
${NORMALIZE_SEARCH_SQL}

-- D2: the two legacy normalizers become the same function (indexes keep their names).
CREATE OR REPLACE FUNCTION public.normalize_arabic(t text)
 RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $function$ SELECT public.normalize_search(t) $function$;

CREATE OR REPLACE FUNCTION public.clean_arabic_text(input_text text)
 RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $function$ SELECT public.normalize_search(input_text) $function$;

-- D1: four triggers wrote search_text_normalized in turn; the last one won and dropped features.
DROP TRIGGER IF EXISTS trg_listings_search_text ON listings;
DROP TRIGGER IF EXISTS trg_sync_listing_search_text ON listings;
DROP TRIGGER IF EXISTS trg_update_listing_search_text ON listings;
DROP FUNCTION IF EXISTS public.listings_set_search_text();
DROP FUNCTION IF EXISTS public.fn_sync_listing_search_text();
DROP FUNCTION IF EXISTS public.trg_fn_update_listings_search_text();
DROP FUNCTION IF EXISTS public.update_listing_search_text();

CREATE TABLE IF NOT EXISTS compound_synonyms (
  kind text NOT NULL CHECK (kind IN ('compound', 'developer', 'area')),
  key text NOT NULL,
  synonym text NOT NULL,
  synonym_norm text NOT NULL,
  area_key text,
  developer_key text,
  PRIMARY KEY (kind, key, synonym)
);
CREATE INDEX IF NOT EXISTS idx_compound_synonyms_norm ON compound_synonyms (synonym_norm);

CREATE TABLE IF NOT EXISTS search_vocabulary (
  kind text NOT NULL CHECK (kind IN ('type', 'feature')),
  key text NOT NULL,
  terms text NOT NULL,
  PRIMARY KEY (kind, key)
);

ALTER TABLE listings
  ADD COLUMN IF NOT EXISTS compound_key text,
  ADD COLUMN IF NOT EXISTS developer_key text,
  ADD COLUMN IF NOT EXISTS area_key text;

-- Best (longest) synonym of a kind found as whole words in a text.
CREATE OR REPLACE FUNCTION public.match_place(p_kind text, p_text text)
 RETURNS compound_synonyms LANGUAGE sql STABLE
AS $function$
  SELECT s.* FROM compound_synonyms s
  WHERE s.kind = p_kind
    AND (' ' || public.normalize_search(p_text) || ' ') LIKE ('% ' || s.synonym_norm || ' %')
  ORDER BY length(s.synonym_norm) DESC, s.key
  LIMIT 1
$function$;

CREATE OR REPLACE FUNCTION public.listings_search_document()
 RETURNS trigger LANGUAGE plpgsql
AS $function$
DECLARE
  d jsonb := COALESCE(NEW.details, '{}'::jsonb);
  place_text text := concat_ws(' ', NEW.compound, NEW.compound_en, d->>'compound_en');
  c compound_synonyms;
  dv compound_synonyms;
  ar compound_synonyms;
  place_terms text;
  type_terms text;
  feature_terms text;
  legacy_features text := '';
BEGIN
  -- Columns other code paths used to fill from details.
  IF NEW.bathrooms IS NULL AND (d->>'bathrooms') ~ '^[0-9]+$' THEN
    NEW.bathrooms := (d->>'bathrooms')::integer;
  END IF;
  IF NEW.compound_en IS NULL AND d->>'compound_en' IS NOT NULL THEN
    NEW.compound_en := d->>'compound_en';
  END IF;

  -- Language-neutral place keys.
  c := public.match_place('compound', place_text);
  NEW.compound_key := c.key;
  NEW.developer_key := COALESCE(c.developer_key,
    (public.match_place('developer', concat_ws(' ', place_text, d->>'developer'))).key);
  ar := public.match_place('area', concat_ws(' ', NEW.district, NEW.city, NEW.location, place_text));
  NEW.area_key := COALESCE(c.area_key, ar.key);

  SELECT string_agg(s.synonym_norm, ' ') INTO place_terms FROM compound_synonyms s
  WHERE (s.kind = 'compound' AND s.key = NEW.compound_key)
     OR (s.kind = 'developer' AND s.key = NEW.developer_key)
     OR (s.kind = 'area' AND s.key = NEW.area_key);

  SELECT terms INTO type_terms FROM search_vocabulary WHERE kind = 'type' AND key = NEW.property_type;
  SELECT string_agg(terms, ' ') INTO feature_terms FROM search_vocabulary
  WHERE kind = 'feature' AND key = ANY(COALESCE(NEW.feature_keys, '{}'));

  -- Free-text features written before Release 1 stay searchable.
  IF jsonb_typeof(d->'features') = 'array' THEN
    SELECT legacy_features || ' ' || COALESCE(string_agg(value #>> '{}', ' '), '') INTO legacy_features FROM jsonb_array_elements(d->'features');
  END IF;
  IF jsonb_typeof(d->'features_en') = 'array' THEN
    SELECT legacy_features || ' ' || COALESCE(string_agg(value #>> '{}', ' '), '') INTO legacy_features FROM jsonb_array_elements(d->'features_en');
  END IF;

  NEW.search_text_normalized := public.normalize_search(concat_ws(' ',
    NEW.code, NEW.title, NEW.compound, NEW.compound_en, NEW.district, NEW.city, NEW.location,
    array_to_string(NEW.location_keywords, ' '),
    d->>'title_en', d->>'project', d->>'developer', d->>'finishing', d->>'orientation',
    place_terms, type_terms, feature_terms,
    array_to_string(NEW.features_other, ' '), array_to_string(NEW.features, ' '), legacy_features));
  RETURN NEW;
END;
$function$;

CREATE TRIGGER trg_listings_search_document BEFORE INSERT OR UPDATE ON listings
  FOR EACH ROW EXECUTE FUNCTION listings_search_document();

CREATE INDEX IF NOT EXISTS idx_listings_compound_key ON listings (agency_id, compound_key) WHERE compound_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_listings_developer_key ON listings (agency_id, developer_key) WHERE developer_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_listings_area_key ON listings (agency_id, area_key) WHERE area_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_listings_dev_code_norm ON listings (agency_id, upper(developer_unit_code)) WHERE developer_unit_code IS NOT NULL;
`;

async function up(client) {
  await client.query(SQL);
  await seedVocabulary(client);
  // Rebuild every search document and the indexes on the redefined normalizers.
  await client.query("UPDATE listings SET compound = compound");
  await client.query("REINDEX INDEX idx_listings_search_trgm");
  await client.query("REINDEX INDEX idx_listings_compound_trgm");
}

module.exports = { up };
