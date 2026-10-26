-- 037: Google Sheet live sync (Release B, C9). A manager pastes the developer's shared sheet link on a project; the app
-- reads it once a day (as CSV, "anyone with the link" sheets only), and when the rows changed it makes the usual price
-- preview and tells the managers, or applies it straight away when the manager allowed that. Units missing from the
-- sheet are never marked sold automatically.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS sheet_sync jsonb NOT NULL DEFAULT '{}'::jsonb;
