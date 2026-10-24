-- 008: web imports (Excel diff, group posts / chat export). A plan is stored server-side between the
-- preview and the apply, so the browser never sends back the rows it is applying.
CREATE TABLE IF NOT EXISTS web_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id uuid NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  broker_id uuid NOT NULL REFERENCES brokers(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('excel', 'group')),
  status text NOT NULL DEFAULT 'ready' CHECK (status IN ('processing', 'ready', 'applied', 'failed')),
  filename text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + INTERVAL '1 day',
  applied_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_web_imports_broker ON web_imports (agency_id, broker_id, created_at DESC);
