-- 047: F20 project materials can be uploaded files (PDF or image) kept in storage, not only links.
ALTER TABLE project_materials ADD COLUMN IF NOT EXISTS storage_path text;
ALTER TABLE project_materials ADD COLUMN IF NOT EXISTS file_bytes integer;
