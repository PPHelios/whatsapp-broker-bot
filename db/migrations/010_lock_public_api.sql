-- 010: close Supabase's auto-generated Data API (PostgREST) over the public schema. The app reaches
-- Postgres only through DATABASE_URL as the table owner (bypasses RLS) and Storage through the service
-- role, so the anon and authenticated roles need nothing here. Release 3 stores client personal data
-- (leads, PDPL), so every table gets RLS with no policies (deny by default) and the API roles lose
-- their grants, now and for tables created later. The role steps are skipped where the Supabase roles
-- don't exist (local Postgres, the PGlite test harness).

-- RLS on every table in public (no policies: the API roles see no rows even if a grant comes back).
DO $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.relname);
  END LOOP;
END $$;

-- The outbound counter view runs with the caller's rights, so RLS on operation_logs applies through it.
ALTER VIEW agency_outbound_daily SET (security_invoker = true);

-- No Data API access for anon or authenticated, on what exists and on what later migrations create.
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM %I', r);
    END IF;
  END LOOP;
END $$;
