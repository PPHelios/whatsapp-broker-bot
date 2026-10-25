-- 014: lead imports (Release 3 step 6). A CSV or Excel file of clients is planned, previewed and applied once
-- through the same web_imports table as the inventory imports; the apply runs in the background and stores its
-- progress in result ({ done, total }).
ALTER TABLE web_imports DROP CONSTRAINT IF EXISTS web_imports_kind_check;
ALTER TABLE web_imports ADD CONSTRAINT web_imports_kind_check CHECK (kind IN ('excel', 'group', 'leads'));
