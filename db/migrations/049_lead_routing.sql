-- 049: P2 who gets new leads. agencies.lead_routing = { round_robin (default on), order: [broker ids, first gets the
-- next lead], last: the broker who got the last one }. Off: leads from intakes stay with the managers and the response
-- rule stops at the first broker.
ALTER TABLE agencies ADD COLUMN IF NOT EXISTS lead_routing jsonb NOT NULL DEFAULT '{}'::jsonb;
