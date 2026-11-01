-- 058: unified unit import (one screen for Excel, WhatsApp chats and pasted posts). A plan keeps one row per unit in
-- import_rows instead of one JSON value, so a tab page, a tick or a row edit touches only its rows. Rows go with their
-- import: the import's expiry, apply or cancel deletes them (ON DELETE CASCADE).
CREATE TABLE IF NOT EXISTS import_rows (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id   UUID NOT NULL REFERENCES web_imports(id) ON DELETE CASCADE,
  agency_id   UUID NOT NULL,
  seq         INTEGER NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('excel', 'post', 'chat')),
  code        TEXT,
  kind        TEXT NOT NULL CHECK (kind IN ('new', 'changed', 'unchanged', 'invalid', 'forbidden', 'duplicate_code', 'duplicate_unit', 'photos_only')),
  ticked      BOOLEAN NOT NULL DEFAULT FALSE,
  data        JSONB NOT NULL DEFAULT '{}'::jsonb,
  photos      JSONB NOT NULL DEFAULT '[]'::jsonb,
  reasons     JSONB NOT NULL DEFAULT '[]'::jsonb,
  state       TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'done', 'failed', 'conflict')),
  UNIQUE (import_id, seq)
);
CREATE INDEX IF NOT EXISTS import_rows_tab_idx ON import_rows (import_id, kind, seq);
CREATE INDEX IF NOT EXISTS import_rows_agency_idx ON import_rows (agency_id);
ALTER TABLE import_rows ENABLE ROW LEVEL SECURITY;
