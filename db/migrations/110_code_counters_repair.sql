-- Running numbers (owner, deal, lead, unit) that fell behind the highest number in use: bring each up to it.
-- The code that hands out numbers now does the same check on every use, so this only tidies the stored counters.
UPDATE agencies a SET owner_code_next = m.mx + 1
  FROM (SELECT agency_id, max(substring(code from 3)::int) AS mx FROM unit_owners WHERE code ~ '^O-[0-9]{1,9}$' GROUP BY agency_id) m
 WHERE m.agency_id = a.id AND a.owner_code_next <= m.mx;
UPDATE agencies a SET deal_ref_seq = m.mx
  FROM (SELECT agency_id, max(ref) AS mx FROM deals GROUP BY agency_id) m
 WHERE m.agency_id = a.id AND a.deal_ref_seq < m.mx;
UPDATE agencies a SET lead_ref_seq = m.mx
  FROM (SELECT agency_id, max(ref) AS mx FROM leads GROUP BY agency_id) m
 WHERE m.agency_id = a.id AND a.lead_ref_seq < m.mx;
