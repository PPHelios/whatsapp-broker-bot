-- 051: a question the assistant could not answer is marked done once a manager adds the information it needed.
ALTER TABLE assistant_questions ADD COLUMN IF NOT EXISTS resolved_at timestamp with time zone;
