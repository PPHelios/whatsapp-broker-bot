-- 056: secret-details requests go manager first, then the agency owner. 'owner_review' = a manager said yes and the
-- agency owner's yes is still needed; the manager's step is kept for the log.
ALTER TABLE unit_access_requests DROP CONSTRAINT IF EXISTS unit_access_requests_status_check;
ALTER TABLE unit_access_requests ADD CONSTRAINT unit_access_requests_status_check CHECK (status IN ('pending', 'owner_review', 'approved', 'declined'));
ALTER TABLE unit_access_requests ADD COLUMN IF NOT EXISTS manager_decided_by uuid REFERENCES brokers(id) ON DELETE SET NULL;
ALTER TABLE unit_access_requests ADD COLUMN IF NOT EXISTS manager_decided_at timestamp with time zone;
