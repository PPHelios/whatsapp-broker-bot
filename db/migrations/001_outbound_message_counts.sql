-- 001: daily outbound WhatsApp message counts per agency (rows written by lib/dispatcher.js deliver()).
CREATE OR REPLACE VIEW agency_outbound_daily AS
SELECT
  agency_id,
  (created_at AT TIME ZONE 'Africa/Cairo')::date AS day,
  count(*) FILTER (WHERE status = 'success') AS sent,
  count(*) FILTER (WHERE status <> 'success') AS failed
FROM operation_logs
WHERE operation_type = 'wa_outbound'
GROUP BY 1, 2;
