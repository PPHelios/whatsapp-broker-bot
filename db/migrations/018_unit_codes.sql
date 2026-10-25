-- 018: short auto-generated unit codes (owner's choice 2026-10-25): <agency initials>-<type letter><running number>,
-- e.g. NH-V12. code_prefix is set from the agency's name on first use (domain/unitCode.js) and editable by managers;
-- unit_code_seq is the agency's running number. Existing codes are untouched.
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS code_prefix text CHECK (code_prefix IS NULL OR code_prefix ~ '^[A-Z]{1,4}$');
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS unit_code_seq integer NOT NULL DEFAULT 0;
