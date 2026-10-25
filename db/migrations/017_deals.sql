-- 017: deals and commission (Release 3 step 10, Q10: negotiated per deal). A deal records who closed which unit for
-- which client, the price and the commission the broker typed (an amount or a percentage), an external co-broker's
-- share off the top, and the colleagues' shares in whole EGP (deal_splits; the closing broker's row holds the rest).
-- The shares must add up exactly: a deferred constraint trigger checks it at commit. The client's name and phone are
-- copied for the record and cleared when the client is erased (step 11). Commission never reaches a client copy.
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS deal_ref_seq integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS deals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id uuid NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  ref integer NOT NULL CHECK (ref > 0), -- shown as D-0007, unique per agency
  lead_id uuid REFERENCES leads(id) ON DELETE SET NULL,
  listing_id uuid REFERENCES listings(id) ON DELETE SET NULL,
  unit_code text,
  closing_broker_id uuid NOT NULL REFERENCES brokers(id),
  created_by_broker_id uuid REFERENCES brokers(id) ON DELETE SET NULL,
  deal_type text NOT NULL CHECK (deal_type IN ('sale', 'rent')),
  price numeric(14, 0) NOT NULL CHECK (price > 0),
  commission_mode text NOT NULL CHECK (commission_mode IN ('amount', 'pct')),
  commission_pct numeric(6, 3) CHECK (commission_pct IS NULL OR (commission_pct > 0 AND commission_pct <= 100)),
  commission_total bigint NOT NULL CHECK (commission_total >= 0),
  external_share bigint NOT NULL DEFAULT 0 CHECK (external_share >= 0 AND external_share <= commission_total),
  external_name text CHECK (external_name IS NULL OR length(external_name) <= 120),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'signed', 'paid', 'cancelled')),
  client_name text CHECK (client_name IS NULL OR length(client_name) <= 120),
  client_phone text,
  notes text CHECK (notes IS NULL OR length(notes) <= 1000),
  idem_key text,
  version integer NOT NULL DEFAULT 1,
  closed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agency_id, ref),
  UNIQUE (agency_id, idem_key)
);
CREATE INDEX IF NOT EXISTS idx_deals_agency_closed ON deals (agency_id, closed_at DESC);
CREATE INDEX IF NOT EXISTS idx_deals_lead ON deals (lead_id) WHERE lead_id IS NOT NULL;
ALTER TABLE deals ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS deal_splits (
  deal_id uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  agency_id uuid NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  broker_id uuid NOT NULL REFERENCES brokers(id),
  pct numeric(6, 3) NOT NULL CHECK (pct >= 0 AND pct <= 100),
  amount bigint NOT NULL CHECK (amount >= 0),
  PRIMARY KEY (deal_id, broker_id)
);
CREATE INDEX IF NOT EXISTS idx_deal_splits_broker ON deal_splits (agency_id, broker_id);
ALTER TABLE deal_splits ENABLE ROW LEVEL SECURITY;

-- References inside a deal stay in its agency.
CREATE OR REPLACE FUNCTION deals_same_agency() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.lead_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM leads WHERE id = NEW.lead_id AND agency_id = NEW.agency_id) THEN
    RAISE EXCEPTION 'deal % on a lead of another agency', NEW.id USING ERRCODE = '23514';
  END IF;
  IF NEW.listing_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM listings WHERE id = NEW.listing_id AND agency_id = NEW.agency_id) THEN
    RAISE EXCEPTION 'deal % on a unit of another agency', NEW.id USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM brokers WHERE id = NEW.closing_broker_id AND agency_id = NEW.agency_id) THEN
    RAISE EXCEPTION 'deal % closed by a broker of another agency', NEW.id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_deals_same_agency ON deals;
CREATE TRIGGER trg_deals_same_agency BEFORE INSERT OR UPDATE OF agency_id, lead_id, listing_id, closing_broker_id
  ON deals FOR EACH ROW EXECUTE FUNCTION deals_same_agency();

CREATE OR REPLACE FUNCTION deal_splits_same_agency() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM deals WHERE id = NEW.deal_id AND agency_id = NEW.agency_id)
     OR NOT EXISTS (SELECT 1 FROM brokers WHERE id = NEW.broker_id AND agency_id = NEW.agency_id) THEN
    RAISE EXCEPTION 'deal share outside the deal''s agency' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_deal_splits_same_agency ON deal_splits;
CREATE TRIGGER trg_deal_splits_same_agency BEFORE INSERT OR UPDATE ON deal_splits FOR EACH ROW EXECUTE FUNCTION deal_splits_same_agency();

-- The shares add up exactly to the commission less the external share (checked at commit, after every row is written).
CREATE OR REPLACE FUNCTION deal_shares_balance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  d uuid;
  want bigint;
  got bigint;
BEGIN
  IF TG_TABLE_NAME = 'deals' THEN
    d := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    d := OLD.deal_id;
  ELSE
    d := NEW.deal_id;
  END IF;
  SELECT commission_total - external_share INTO want FROM deals WHERE id = d;
  IF want IS NULL THEN RETURN NULL; END IF;
  SELECT COALESCE(sum(amount), 0) INTO got FROM deal_splits WHERE deal_id = d;
  IF got <> want THEN
    RAISE EXCEPTION 'deal % shares add up to %, not %', d, got, want USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trg_deal_shares_balance ON deal_splits;
CREATE CONSTRAINT TRIGGER trg_deal_shares_balance AFTER INSERT OR UPDATE OR DELETE ON deal_splits
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION deal_shares_balance();
DROP TRIGGER IF EXISTS trg_deal_total_balance ON deals;
CREATE CONSTRAINT TRIGGER trg_deal_total_balance AFTER INSERT OR UPDATE OF commission_total, external_share ON deals
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION deal_shares_balance();
