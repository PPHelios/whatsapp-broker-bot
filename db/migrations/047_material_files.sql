-- 047: F20 project materials can be uploaded files (PDF, photo or sheet) kept in storage, not only links.
-- F21: a developer's payment plans file read by AI waits on the project as a preview until a manager saves it.
ALTER TABLE project_materials ADD COLUMN IF NOT EXISTS storage_path text;
ALTER TABLE project_materials ADD COLUMN IF NOT EXISTS file_bytes integer;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS plans_draft jsonb;
