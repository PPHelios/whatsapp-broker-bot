-- 046: a lease's tenant can be one of the agency's leads (F10): the tenant field takes a lead ref (L-0042), the lease
-- then shows on that lead's page. A free-text name stays the fallback.
ALTER TABLE leases ADD COLUMN IF NOT EXISTS tenant_lead_id uuid REFERENCES leads(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS leases_tenant_lead_idx ON leases (tenant_lead_id) WHERE tenant_lead_id IS NOT NULL;
