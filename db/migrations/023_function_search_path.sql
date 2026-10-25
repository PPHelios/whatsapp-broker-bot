-- 023: pin search_path on our own functions (4.7 audit, Supabase advisor "function_search_path_mutable"). Without it a
-- function resolves names through the caller's search_path, so a role able to create objects in an earlier schema could
-- shadow a table or operator the function uses. public stays first (pg_trgm lives there), pg_temp last.
DO $$
DECLARE f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proconfig IS NULL AND p.proname IN (
       'clean_arabic_text', 'match_place', 'listings_search_document', 'agency_slug_base', 'agencies_set_slug',
       'normalize_search', 'set_listing_image_agency_id', 'normalize_arabic', 'update_timestamp_column',
       'leads_same_agency', 'deals_same_agency', 'deal_splits_same_agency', 'deal_shares_balance')
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = public, pg_temp', f.sig);
  END LOOP;
END $$;
