-- 013: the CRM's leads (Release 3 step 3). A lead is personal data about the agency's client (PDPL,
-- Law 151/2020): every row records its lawful basis, access is limited by role in services/leads.js,
-- and nothing here ever reaches a public page.
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS lead_ref_seq integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id uuid NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  ref integer NOT NULL CHECK (ref > 0), -- shown as L-0042, unique per agency
  kind text NOT NULL DEFAULT 'buyer' CHECK (kind IN ('buyer', 'tenant', 'seller', 'landlord')),
  assigned_broker_id uuid REFERENCES brokers(id) ON DELETE SET NULL,
  created_by_broker_id uuid REFERENCES brokers(id) ON DELETE SET NULL,
  name text CHECK (name IS NULL OR length(name) <= 120),
  phone_e164 text NOT NULL CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  phones text[] NOT NULL DEFAULT '{}' CHECK (cardinality(phones) BETWEEN 1 AND 3),
  lang text CHECK (lang IN ('ar', 'en')),
  source text CHECK (source IS NULL OR length(source) <= 60),
  lawful_basis text NOT NULL CHECK (lawful_basis IN ('client_request', 'consent', 'existing_client')),
  consent_at timestamptz,
  consent_note text,
  stage text NOT NULL DEFAULT 'new' CHECK (stage IN ('new', 'contacted', 'interested', 'viewing', 'negotiation', 'won', 'lost')),
  lost_reason text,
  notes text CHECK (notes IS NULL OR length(notes) <= 4000),
  next_follow_up_at timestamptz,
  follow_up_kind text CHECK (follow_up_kind IN ('call', 'viewing')),
  follow_up_listing_id uuid REFERENCES listings(id) ON DELETE SET NULL,
  follow_up_note text,
  follow_up_status text CHECK (follow_up_status IN ('open', 'done')),
  hot_at timestamptz,
  last_contact_at timestamptz,
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  UNIQUE (agency_id, ref),
  UNIQUE (agency_id, phone_e164),
  CHECK (stage <> 'lost' OR lost_reason IS NOT NULL),
  CHECK (phone_e164 = phones[1])
);
-- Dedupe checks every number of every lead (main + second + third).
CREATE INDEX IF NOT EXISTS idx_leads_phones ON leads USING gin (phones);
CREATE INDEX IF NOT EXISTS idx_leads_assigned ON leads (agency_id, assigned_broker_id, last_activity_at DESC);
CREATE INDEX IF NOT EXISTS idx_leads_follow_up ON leads (next_follow_up_at) WHERE follow_up_status = 'open';
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;

-- References inside a lead must stay in its agency (a broker or unit of another agency is refused).
CREATE OR REPLACE FUNCTION leads_same_agency() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.assigned_broker_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM brokers WHERE id = NEW.assigned_broker_id AND agency_id = NEW.agency_id) THEN
    RAISE EXCEPTION 'lead % assigned to a broker of another agency', NEW.id USING ERRCODE = '23514';
  END IF;
  IF NEW.created_by_broker_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM brokers WHERE id = NEW.created_by_broker_id AND agency_id = NEW.agency_id) THEN
    RAISE EXCEPTION 'lead % created by a broker of another agency', NEW.id USING ERRCODE = '23514';
  END IF;
  IF NEW.follow_up_listing_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM listings WHERE id = NEW.follow_up_listing_id AND agency_id = NEW.agency_id) THEN
    RAISE EXCEPTION 'lead % follow-up on a unit of another agency', NEW.id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_leads_same_agency ON leads;
CREATE TRIGGER trg_leads_same_agency BEFORE INSERT OR UPDATE OF agency_id, assigned_broker_id, created_by_broker_id, follow_up_listing_id
  ON leads FOR EACH ROW EXECUTE FUNCTION leads_same_agency();

-- The timeline: append-only (an undo is a new event; the original is only stamped undone_at).
CREATE TABLE IF NOT EXISTS lead_events (
  id bigserial PRIMARY KEY,
  agency_id uuid NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  broker_id uuid REFERENCES brokers(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('created', 'inquiry', 'assigned', 'stage', 'note', 'contacted', 'follow_up_set', 'follow_up_done',
    'request_set', 'match_sent', 'share_opened', 'deal', 'exported', 'merged', 'undo')),
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  undone_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_lead_events_lead ON lead_events (lead_id, created_at DESC, id DESC);
ALTER TABLE lead_events ENABLE ROW LEVEL SECURITY;

-- Erased clients: only a keyed hash of each phone (LEAD_HASH_KEY), so a re-capture can warn.
CREATE TABLE IF NOT EXISTS lead_erasures (
  agency_id uuid NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  phone_hash text NOT NULL,
  erased_at timestamptz NOT NULL DEFAULT now(),
  erased_by_broker_id uuid REFERENCES brokers(id) ON DELETE SET NULL,
  PRIMARY KEY (agency_id, phone_hash)
);
ALTER TABLE lead_erasures ENABLE ROW LEVEL SECURITY;
