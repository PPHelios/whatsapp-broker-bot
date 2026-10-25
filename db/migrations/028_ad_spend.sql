-- 028: ad spend per lead source and month (phase 2 step 7). Managers type what they paid for each source in a month
-- (Facebook, a Meta campaign name, Property Finder…); the source report divides it by the leads and deals that came
-- from that source in that month (services/leadSources.js). month is the first day of the Cairo month.
CREATE TABLE IF NOT EXISTS ad_spend (
  agency_id uuid NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  month date NOT NULL CHECK (extract(day FROM month) = 1),
  source text NOT NULL CHECK (length(source) BETWEEN 1 AND 60),
  amount_egp bigint NOT NULL CHECK (amount_egp >= 0),
  updated_by uuid REFERENCES brokers(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agency_id, month, source)
);
ALTER TABLE ad_spend ENABLE ROW LEVEL SECURITY;
