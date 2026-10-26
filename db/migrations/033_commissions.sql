-- 033: the commission tracker (Release A, C8). Each catalogue project can carry the developer's commission terms (a rate
-- or a fixed amount, rate tiers by units sold in the year, what makes it claimable, the developer's payment days, how
-- long a client registration lasts). Every deal on a project unit gets one commission row that moves expected →
-- claimable → claimed (invoice number and link) → paid or partly paid (payments listed); overdue claims show in the
-- managers' morning brief every 7 days. No VAT is computed: the amounts are what the developer pays.
CREATE TABLE IF NOT EXISTS commission_terms (
  project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  agency_id uuid NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  mode text NOT NULL DEFAULT 'pct' CHECK (mode IN ('pct', 'amount')),
  pct numeric(6,3) CHECK (pct IS NULL OR (pct > 0 AND pct <= 20)),
  amount bigint CHECK (amount IS NULL OR amount > 0),
  tiers jsonb NOT NULL DEFAULT '[]'::jsonb,
  claim_trigger text NOT NULL DEFAULT 'contract' CHECK (claim_trigger IN ('contract', 'down_payment', 'paid_pct')),
  claim_paid_pct numeric(5,2) CHECK (claim_paid_pct IS NULL OR (claim_paid_pct > 0 AND claim_paid_pct <= 100)),
  payment_days integer NOT NULL DEFAULT 60 CHECK (payment_days BETWEEN 0 AND 365),
  registration_days integer CHECK (registration_days IS NULL OR registration_days BETWEEN 1 AND 365),
  notes text CHECK (notes IS NULL OR length(notes) <= 1000),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE commission_terms ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS commissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id uuid NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  deal_id uuid NOT NULL UNIQUE REFERENCES deals(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  developer_id uuid REFERENCES developers(id) ON DELETE SET NULL,
  rate_pct numeric(6,3),
  expected_amount bigint NOT NULL CHECK (expected_amount >= 0),
  status text NOT NULL DEFAULT 'expected' CHECK (status IN ('expected', 'claimable', 'claimed', 'partly_paid', 'paid', 'cancelled')),
  claimable_at timestamptz,
  claimed_at timestamptz,
  invoice_no text CHECK (invoice_no IS NULL OR length(invoice_no) <= 60),
  invoice_url text CHECK (invoice_url IS NULL OR length(invoice_url) <= 500),
  due_on date,
  payments jsonb NOT NULL DEFAULT '[]'::jsonb,
  paid_amount bigint NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
  paid_at timestamptz,
  client_registered_on date,
  registration_expires_on date,
  notes text CHECK (notes IS NULL OR length(notes) <= 1000),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_commissions_agency_status ON commissions (agency_id, status);
CREATE INDEX IF NOT EXISTS idx_commissions_developer ON commissions (developer_id);
ALTER TABLE commissions ENABLE ROW LEVEL SECURITY;
