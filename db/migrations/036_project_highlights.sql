-- 036: brochure highlights (Release B, C6). A manager may upload the project's brochure (PDF pages or photos, under
-- the same owner switch, allowance and page cache as price lists); the facts each page states are kept on the
-- project (brochure: facts, pages, file name, when) for the project assistant, and 3 to 5 highlight lines are
-- suggested from them in Arabic and English. The manager edits and saves the lines (highlights), or types them.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS brochure jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS highlights jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS highlights_at timestamptz;
