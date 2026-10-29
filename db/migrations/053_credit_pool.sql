-- 053: AI credit pool. Plans, extra credit bundles and the credits each action uses live in the database and are set
-- from the owner page (/app/owner); the code keeps no prices. Plans keep their seats, unit caps and trial rules; a
-- seat gets the credits in the plan's pool (400 per seat on every paid plan). Bundles add credits for the Cairo month
-- they are bought. Google Search grounding is not used: no search costs.
CREATE TABLE IF NOT EXISTS credit_plans (
  id text PRIMARY KEY,
  name_ar text NOT NULL,
  name_en text NOT NULL,
  price_egp integer NOT NULL CHECK (price_egp >= 0),
  seats integer NOT NULL CHECK (seats >= 1),
  units integer NOT NULL CHECK (units >= 1),
  credits integer NOT NULL CHECK (credits >= 0),
  sort integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS credit_bundles (
  id text PRIMARY KEY,
  name_ar text NOT NULL,
  name_en text NOT NULL,
  price_egp integer NOT NULL CHECK (price_egp > 0),
  credits integer NOT NULL CHECK (credits > 0),
  sort integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS credit_actions (
  action text PRIMARY KEY,
  label_ar text NOT NULL,
  label_en text NOT NULL,
  credits integer NOT NULL CHECK (credits >= 0),
  sort integer NOT NULL DEFAULT 0,
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS credit_requests (
  id bigserial PRIMARY KEY,
  agency_id uuid NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  broker_id uuid REFERENCES brokers(id) ON DELETE SET NULL,
  credits integer NOT NULL CHECK (credits > 0),
  note text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined')),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  decided_at timestamp with time zone
);
CREATE INDEX IF NOT EXISTS idx_credit_requests_status ON credit_requests (status, created_at);

-- Extra credits the owner gives one agency for one Cairo month (key = 'YYYY-MM').
CREATE TABLE IF NOT EXISTS credit_grants (
  agency_id uuid NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  month text NOT NULL,
  credits integer NOT NULL CHECK (credits > 0),
  note text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY (agency_id, month, created_at)
);

-- Starting values (today's plans, with 400 credits per seat). The owner page edits them from here on.
INSERT INTO credit_plans (id, name_ar, name_en, price_egp, seats, units, credits, sort) VALUES
  ('free', 'مجاني', 'Free', 0, 1, 25, 80, 0),
  ('solo', 'سولو', 'Solo', 199, 1, 300, 400, 1),
  ('office', 'مكتب', 'Office', 830, 5, 1500, 2000, 2),
  ('agency', 'وكالة', 'Agency', 2090, 15, 5000, 6000, 3)
ON CONFLICT (id) DO NOTHING;

INSERT INTO credit_bundles (id, name_ar, name_en, price_egp, credits, sort) VALUES
  ('small', 'باقة صغيرة', 'Small', 79, 200, 1),
  ('medium', 'باقة متوسطة', 'Medium', 175, 500, 2),
  ('large', 'باقة كبيرة', 'Large', 349, 1000, 3)
ON CONFLICT (id) DO NOTHING;

INSERT INTO credit_actions (action, label_ar, label_en, credits, sort) VALUES
  ('text', 'طلب نصي (إضافة وحدة، بحث، ليد، متابعة، تحديث)', 'Text request (add unit, search, lead, follow-up, update)', 1, 1),
  ('voice', 'فويس (مرة واحدة، والبوت يكمل بيه)', 'Voice note (once, covers what the bot does next)', 3, 2),
  ('flyer', 'فلاير: أول فلاير للوحدة أو بعد صور جديدة', 'Flyer: first flyer for a unit, or after new photos', 3, 3),
  ('page', 'صفحة قائمة أسعار أو كتيب أو خطة سداد أو معرض (بتتقري بالذكاء)', 'Price-list, brochure, payment-plan or gallery page read by AI', 10, 4),
  ('chat_post', 'بوست من تصدير المحادثة', 'Chat-export post the AI reads', 1, 5),
  ('assistant', 'سؤال للمساعد عن بياناتك', 'Assistant question about your data', 2, 6)
ON CONFLICT (action) DO NOTHING;

-- Extra bundles are bought like plans and voice packs: announced by a manager, confirmed by the owner. The voice pack
-- stays valid for old rows only.
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_kind_check;
ALTER TABLE payments ADD CONSTRAINT payments_kind_check CHECK (kind IN ('plan', 'voice_pack', 'credit_bundle'));
ALTER TABLE payments ADD COLUMN IF NOT EXISTS bundle_id text REFERENCES credit_bundles(id);

-- The owner can add plans from the dashboard, so the plan ids are no longer a fixed list.
ALTER TABLE agencies DROP CONSTRAINT IF EXISTS agencies_plan_check;
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_plan_check;

ALTER TABLE credit_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_bundles ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_grants ENABLE ROW LEVEL SECURITY;
