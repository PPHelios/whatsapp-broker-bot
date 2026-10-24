-- 005: agencies.slug — the first segment of public unit URLs (/<agency-slug>/<unit-code>).
-- agency_slug_base is the SQL twin of domain/slug.js baseSlug (tests check they agree).

CREATE OR REPLACE FUNCTION public.agency_slug_base(p_name text, p_id uuid)
 RETURNS text LANGUAGE sql IMMUTABLE
AS $function$
  SELECT CASE
    WHEN s = '' OR s = ANY (ARRAY['app', 'api', 'auth', 'login', 'logout', 'webhook', 'health', 'static', 'assets', 'public', 'admin', 's', 'u', 'www', 'aqarchat', 'about', 'help', 'terms', 'privacy', 'pricing', 'blog', 'docs', 'robots', 'favicon', 'manifest', 'sw', 'share', 'new']) THEN 'agency-' || left(replace(p_id::text, '-', ''), 8)
    ELSE s END
  FROM (SELECT btrim(left(btrim(regexp_replace(lower(coalesce(p_name, '')), '[^a-z0-9]+', '-', 'g'), '-'), 40), '-') AS s) x
$function$;

-- A missing slug is derived from the name and made unique with -2, -3, ...
CREATE OR REPLACE FUNCTION public.agencies_set_slug()
 RETURNS trigger LANGUAGE plpgsql
AS $function$
DECLARE
  base text;
  cand text;
  n integer := 1;
BEGIN
  IF NEW.slug IS NOT NULL AND btrim(NEW.slug) <> '' THEN
    NEW.slug := lower(btrim(NEW.slug));
    RETURN NEW;
  END IF;
  base := public.agency_slug_base(NEW.name, NEW.id);
  cand := base;
  WHILE EXISTS (SELECT 1 FROM agencies WHERE slug = cand AND id <> NEW.id) LOOP
    n := n + 1;
    cand := base || '-' || n;
  END LOOP;
  NEW.slug := cand;
  RETURN NEW;
END;
$function$;

ALTER TABLE agencies ADD COLUMN IF NOT EXISTS slug text;

CREATE TRIGGER trg_agencies_slug BEFORE INSERT OR UPDATE OF slug, name ON agencies
  FOR EACH ROW WHEN (NEW.slug IS NULL OR btrim(NEW.slug) = '' OR NEW.slug <> lower(btrim(NEW.slug)))
  EXECUTE FUNCTION agencies_set_slug();

-- Backfill in a stable order (oldest agency keeps the plain slug).
DO $do$
DECLARE r record;
BEGIN
  FOR r IN SELECT id FROM agencies WHERE slug IS NULL ORDER BY created_at, id LOOP
    UPDATE agencies SET slug = NULL WHERE id = r.id;
  END LOOP;
END
$do$;

ALTER TABLE agencies ALTER COLUMN slug SET NOT NULL;
ALTER TABLE agencies ADD CONSTRAINT agencies_slug_format CHECK (
  slug ~ '^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$' AND NOT (slug = ANY (ARRAY['app', 'api', 'auth', 'login', 'logout', 'webhook', 'health', 'static', 'assets', 'public', 'admin', 's', 'u', 'www', 'aqarchat', 'about', 'help', 'terms', 'privacy', 'pricing', 'blog', 'docs', 'robots', 'favicon', 'manifest', 'sw', 'share', 'new']))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_agencies_slug ON agencies (slug);
