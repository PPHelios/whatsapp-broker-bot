-- 026: duplicate-photo flag and chat-export zip uploads (phase 2 step 5).
-- listing_images.phash (bit(64), in the base schema, unused until now) holds a difference hash of the photo
-- (services/photoHash.js): two photos whose hashes differ in at most a few bits are the same picture, even resized
-- or recompressed. NULL until computed; an hourly job fills older photos.
CREATE INDEX IF NOT EXISTS listing_images_agency_phash_idx ON listing_images (agency_id) WHERE phash IS NOT NULL;

-- The private bucket the browser uploads WhatsApp chat exports (.zip with photos) to with a signed URL; the server
-- reads the zip once and deletes it. Only on Supabase (the test database has no storage schema).
DO $$ BEGIN
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    EXECUTE $q$INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
      VALUES ('chat-imports', 'chat-imports', false, 209715200, ARRAY['application/zip', 'application/x-zip-compressed', 'application/octet-stream'])
      ON CONFLICT (id) DO NOTHING$q$;
  END IF;
EXCEPTION WHEN insufficient_privilege OR undefined_column THEN
  RAISE NOTICE 'chat-imports bucket not created here (%); create it in the Supabase dashboard', SQLERRM;
END $$;
