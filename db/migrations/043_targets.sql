-- 043: monthly targets per broker (Release B, N6). A manager sets a standing monthly target of deals and/or
-- commission (EGP, the broker's share) for each broker; progress for the current Cairo month shows in the broker's
-- morning brief, on the agency dashboard and on the Team page. Empty means no target.
ALTER TABLE brokers ADD COLUMN IF NOT EXISTS target_deals smallint CHECK (target_deals IS NULL OR target_deals BETWEEN 1 AND 1000);
ALTER TABLE brokers ADD COLUMN IF NOT EXISTS target_commission bigint CHECK (target_commission IS NULL OR target_commission > 0);
