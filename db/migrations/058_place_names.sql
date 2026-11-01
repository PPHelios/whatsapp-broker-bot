-- 058: English compound names the app has not seen before, waiting for their Arabic name. A name arrives on a unit
-- (lib/drafts.js) and is saved once as pending; the CRM owner gives the Arabic name on /app/owner, then it is approved and
-- search uses it. Names are global (one name, one Arabic form for every agency).
CREATE TABLE IF NOT EXISTS place_names (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name_key text NOT NULL UNIQUE,
  name_en text NOT NULL,
  name_ar text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved')),
  times_seen integer NOT NULL DEFAULT 1,
  example text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  decided_at timestamp with time zone
);
CREATE INDEX IF NOT EXISTS place_names_status ON place_names (status, times_seen DESC);
ALTER TABLE place_names ENABLE ROW LEVEL SECURITY;
