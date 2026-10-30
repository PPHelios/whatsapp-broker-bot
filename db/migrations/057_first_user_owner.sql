-- 057: the first user of an agency is its agency owner. Agencies created before this change have an 'admin' who held that
-- place; where an agency has no owner, its earliest-created admin becomes the owner.
UPDATE brokers b SET role = 'owner'
 WHERE b.role = 'admin'
   AND NOT EXISTS (SELECT 1 FROM brokers o WHERE o.agency_id = b.agency_id AND o.role = 'owner')
   AND b.id = (SELECT id FROM brokers f WHERE f.agency_id = b.agency_id AND f.role = 'admin' ORDER BY f.created_at, f.id LIMIT 1);
