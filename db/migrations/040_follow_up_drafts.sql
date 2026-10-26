-- 040: follow-up message drafts (Release B, N2). After a call or viewing the bot (or the lead page) drafts the next
-- WhatsApp message to the client from the lead's own record. brokers.draft_style is an optional sample of how the
-- broker writes to clients (Settings), so drafts sound like them.
ALTER TABLE brokers ADD COLUMN IF NOT EXISTS draft_style text CHECK (draft_style IS NULL OR length(draft_style) <= 600);
