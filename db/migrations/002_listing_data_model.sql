-- 002: structured listing data model (Release 1 step 2)
-- Delivery, feature keys + free-text extras, resale schedule, confirmed_at, normalized code, market.

ALTER TABLE listings
  ADD COLUMN IF NOT EXISTS delivery_year smallint,
  ADD COLUMN IF NOT EXISTS delivery_quarter smallint,
  ADD COLUMN IF NOT EXISTS delivery_month smallint,
  ADD COLUMN IF NOT EXISTS is_ready boolean,
  ADD COLUMN IF NOT EXISTS delivery_raw text,
  ADD COLUMN IF NOT EXISTS feature_keys text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS features_other text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS remaining_amount numeric,
  ADD COLUMN IF NOT EXISTS installments_end date,
  ADD COLUMN IF NOT EXISTS confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS market text NOT NULL DEFAULT 'resale',
  ADD COLUMN IF NOT EXISTS finishing text,
  ADD COLUMN IF NOT EXISTS furnishing text,
  ADD COLUMN IF NOT EXISTS floor_level smallint,
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS code_norm text
    GENERATED ALWAYS AS (upper(translate(btrim(code), '٠١٢٣٤٥٦٧٨٩', '0123456789'))) STORED;

ALTER TABLE listings ADD CONSTRAINT listings_delivery_quarter_check CHECK (delivery_quarter BETWEEN 1 AND 4);
ALTER TABLE listings ADD CONSTRAINT listings_delivery_month_check CHECK (delivery_month BETWEEN 1 AND 12);
ALTER TABLE listings ADD CONSTRAINT listings_market_check CHECK (market IN ('resale', 'primary'));
ALTER TABLE listings ADD CONSTRAINT listings_furnishing_check CHECK (furnishing IN ('furnished', 'semi_furnished', 'unfurnished'));

-- Unknown is unknown: no invented quarterly frequency or 8% maintenance on new rows (F1).
ALTER TABLE listings ALTER COLUMN payment_frequency DROP DEFAULT;
ALTER TABLE listings ALTER COLUMN maintenance_pct DROP DEFAULT;

-- Delivery backfill from both places it was written (column and details JSON).
WITH src AS (
  SELECT id,
         NULLIF(btrim(COALESCE(NULLIF(btrim(delivery_date), ''), details->>'delivery_date')), '') AS raw,
         translate(COALESCE(NULLIF(btrim(delivery_date), ''), details->>'delivery_date', ''), '٠١٢٣٤٥٦٧٨٩', '0123456789') AS t,
         details->>'ready_to_move' AS rtm
  FROM listings
)
UPDATE listings l SET
  delivery_raw = src.raw,
  is_ready = CASE
    WHEN src.rtm = 'true' OR src.t ~* '(فوري|فورى|جاهز|ريدي|ready|immediate|متسلم|مستلم)' THEN true
    ELSE NULL END,
  delivery_year = CASE
    WHEN src.rtm = 'true' OR src.t ~* '(فوري|فورى|جاهز|ريدي|ready|immediate|متسلم|مستلم)' THEN NULL
    ELSE substring(src.t FROM '(20[2-4][0-9])')::smallint END,
  delivery_quarter = CASE
    WHEN substring(src.t FROM '(20[2-4][0-9])') IS NULL THEN NULL
    ELSE substring(src.t FROM '[qQ]\s*([1-4])')::smallint END
FROM src
WHERE src.id = l.id AND (src.raw IS NOT NULL OR src.rtm = 'true');

-- Resale schedule backfill from extracted details.
UPDATE listings SET
  remaining_amount = COALESCE(remaining_amount, NULLIF(details->>'remaining_balance', '')::numeric),
  installment_value = COALESCE(installment_value, NULLIF(details->>'installment_amount', '')::numeric),
  down_payment_value = COALESCE(down_payment_value, NULLIF(details->>'down_payment_value', '')::numeric),
  installment_years = COALESCE(installment_years, round(NULLIF(details->>'installment_years', '')::numeric)::int)
WHERE details ?| array['remaining_balance', 'installment_amount', 'down_payment_value', 'installment_years']
  AND COALESCE(details->>'remaining_balance', details->>'installment_amount', details->>'down_payment_value', details->>'installment_years', '') ~ '^[0-9]+(\.[0-9]+)?$';

UPDATE listings SET market = 'primary'
WHERE is_primary_developer OR inventory_type <> 'resale_unit';

UPDATE listings SET confirmed_at = updated_at WHERE confirmed_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_listings_agency_code_norm ON listings (agency_id, code_norm);
CREATE INDEX IF NOT EXISTS idx_listings_feature_keys ON listings USING gin (feature_keys);
CREATE INDEX IF NOT EXISTS idx_listings_delivery ON listings (agency_id, is_ready, delivery_year);
