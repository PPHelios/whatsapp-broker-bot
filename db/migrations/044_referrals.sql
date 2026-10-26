-- 044: agency referral program (Release B, N9). Every agency gets a short referral code (made on first view). An
-- agency that signs up with a code (or that the owner links to one) records who invited it. When the invited agency's
-- first plan payment is confirmed, it gets one extra month, and so does the agency that invited it: added to its paid
-- period when it is paying, otherwise held as a credit month that is added to its next confirmed plan payment.
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS referral_code text;
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS referred_by uuid REFERENCES agencies(id) ON DELETE SET NULL;
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS referral_rewarded_at timestamptz;
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS referral_credit_months smallint NOT NULL DEFAULT 0 CHECK (referral_credit_months >= 0);
CREATE UNIQUE INDEX IF NOT EXISTS agencies_referral_code_idx ON agencies (referral_code) WHERE referral_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS agencies_referred_by_idx ON agencies (referred_by) WHERE referred_by IS NOT NULL;
