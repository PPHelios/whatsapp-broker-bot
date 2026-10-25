# AqarChat runbook (admin and deploy)

One Node service on Render runs everything: the WhatsApp webhook, the broker web app (`/app/`) and the public unit pages (`/<agency-slug>/<unit-code>?s=<token>`). It talks to Postgres and Storage on Supabase, the WhatsApp Cloud API (Meta) and Gemini. Architecture details: `ARCHITECTURE_MANIFEST.md`; features: `FEATURE_REGISTRY.md`.

## 1. Environment variables

Secrets are set in the Render dashboard (`render.yaml` lists them with `sync: false`). In production (`NODE_ENV=production`) the service refuses to start without the required ones; the log line is `Startup failed: Missing required environment variables: …`.

| Variable | Required | Default | What it is |
| :--- | :--- | :--- | :--- |
| `NODE_ENV` | yes | — | `production` on Render (set by the blueprint). |
| `DATABASE_URL` | yes | — | Supabase Postgres connection string (the pooler URL works). |
| `PUBLIC_BASE_URL` | yes* | `RENDER_EXTERNAL_URL` | Every link the app sends (sign-in links, "refine and see all", client share links, OG tags) is built from it. Must be `https://`. *While unset, Render's own `RENDER_EXTERNAL_URL` (`https://<service>.onrender.com`) is used. Set it to `https://www.aqarchat.com` once the domain points at Render: every new link moves; links already sent keep their old host. |
| `WHATSAPP_APP_SECRET` | yes | — | Meta app secret; every webhook must carry a valid `X-Hub-Signature-256` (fail-closed). |
| `WHATSAPP_VERIFY_TOKEN` | yes | — | The token you type in Meta when subscribing the webhook (`GET /webhook`). |
| `WHATSAPP_ACCESS_TOKEN` | yes | — | System-user token for the Cloud API. |
| `WHATSAPP_PHONE_NUMBER_ID` | yes | — | The bot number's id. |
| `WHATSAPP_API_VERSION` | no | `v25.0` | Graph API version (v25.0 released February 2026; Meta supports a version for about two years, so bump it yearly and check the WhatsApp changelog first). |
| `GEMINI_API_KEY` | yes | — | Production Gemini key (billing on, budget alert set). The eval never uses it. |
| `SUPABASE_URL` | yes for photos | — | Storage project URL (bucket `listing-images`). Without it storage runs in a mock mode: photos are not kept. |
| `SUPABASE_SERVICE_ROLE_KEY` | yes for photos | — | Storage key (server only; never in the browser). `SUPABASE_ANON_KEY` is a fallback. |
| `MALLOC_ARENA_MAX` | no | `2` (blueprint) | Keeps flyer rendering around 250 MB peak RSS. |
| `PORT` | no | `3000` | Render sets it. |
| `MIGRATE_ON_BOOT` | no | `true` | `false` skips migrations at start (then run `npm run migrate` by hand). |
| `DB_POOL_MAX` / `DB_STATEMENT_TIMEOUT_MS` / `DATABASE_SSL` | no | `10` / `10000` / on in production | Pool size, statement timeout, SSL. |
| `BODY_LIMIT` | no | `512kb` | JSON and form bodies (uploads have their own limits: 10 MB a photo, 5 MB an Excel file). |
| `AI_QUOTA_AGENCY_DAILY` / `AI_QUOTA_BROKER_DAILY` | no | `300` / `400` | Daily AI calls; over the limit the broker is told and nothing is lost. |
| `AI_PRICES_JSON` | no | built-in | Model prices for the cost column, e.g. `{"gemini-3.8-flash":{"inPerM":0.75,"outPerM":3.75}}`. Built in (checked 2026-10-25): 3.8/3.6 Flash $0.75 in / $3.75 out per million tokens, rising to $1.50 / $7.50 on 1 January 2027 (applied automatically by date); 3.5 Flash-Lite $0.30 / $2.50. Rows logged before 2026-10-25 used older prices and under-count cost about 10×. |
| `FLYER_WORKER` / `FLYER_MAX_QUEUE` / `FLYER_TIMEOUT_MS` | no | on / `6` / `45000` | Flyer rendering worker thread. |
| `SLOW_QUERY_MS` | no | `1000` | Slow-query log threshold. |
| `WEBHOOK_ALLOW_UNSIGNED` | no | — | Local development only; ignored in production. |
| `WEB_PUSH_PUBLIC_KEY` / `WEB_PUSH_PRIVATE_KEY` | yes | — | VAPID keys for website notifications (web push). Generate once: `node -e "console.log(require('web-push').generateVAPIDKeys())"`. Rotating them turns push off for every broker until they turn it on again in ⚙️ Settings. |
| `LEAD_HASH_KEY` | yes | dev key outside production | Secret for the keyed hash (HMAC-SHA256) of an erased client's phone in `lead_erasures`, so a re-capture can say "this client asked to be deleted" without keeping the number. Generate once: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`. Never rotate it casually: earlier erasures stop matching. |
| `WEB_PUSH_SUBJECT` | no | `mailto:support@aqarchat.com` | Contact the push services see (a `mailto:` or `https:` URL). |
| `WA_CREDITS_MONTHLY` | no | `4000` | Message credits per agency per month (1 credit = 1 WhatsApp message the bot sends). An agency's own value in `agencies.wa_credits_monthly` wins. |
| `WA_CREDITS_CEILING_PCT` | no | `110` | Hard ceiling as a % of the credits: past it a broker gets one notice a day, then read ticks only. |
| `WA_GLOBAL_MONTHLY_CEILING` | no | `8000` | All agencies on our one number together, per month: reaching it is the ceiling for everyone. |
| `WA_LOGIN_MONTHLY_CEILING` | no | `200` | Sign-in links per agency per month (not counted in the credits). |
| `WA_PRICE_EGP` | no | `0.21` | Price of one WhatsApp message (EGP, with VAT), stored on each `wa_outbound` row for our cost reports. |
| `SCHEDULER_ENABLED` | no | `true` (off under tests) | Background jobs (follow-ups, match alerts, retention). `false` stops them on this instance. |
| `BOT_PHONE` | no | — | The bot's WhatsApp number with country code. Only `npm run onboard` reads it, to print each broker's start link (a `bot_phone` in the agency file wins). |
| `SCHEDULER_TICK_MS` | no | `60000` | How often each instance looks for due jobs (at least 5000). Each job still runs on one instance at a time. |

## 2. Render

* **Blueprint:** `render.yaml` (web service `aqarchat`, Starter, Frankfurt, Node 22, `npm ci --omit=dev`, `npm start`, health check `/health`). Create the service from the blueprint, then fill the secrets.
* **Deploys:** if auto-deploy is on for `main`, every merge to `main` goes live. A deploy is healthy when `/health` answers `{"status":"healthy"}`. During a deploy the old instance drains: webhooks get 503 (Meta retries) for up to 25 s.
* **Sizing:** start on Starter. Move to Standard if the Metrics tab shows peak memory above about 400 MB for days.
* **Logs:** Render → service → Logs. Lines are JSON (`level`, `msg`, `agencyId`, `brokerId`); phone numbers are masked and tokens redacted.
* **Webhook URL in Meta:** `<PUBLIC_BASE_URL>/webhook`, verify token = `WHATSAPP_VERIFY_TOKEN`, field `messages`.

## 3. Migrations

* Files live in `db/migrations/` (`NNN_name.sql`, or `NNN_name.js` exporting `up(client)`). They run in order at start (unless `MIGRATE_ON_BOOT=false`), each in its own transaction, under an advisory lock so two instances never run them twice, and are recorded in `schema_migrations`.
* By hand: `npm run migrate` (reads `.env`). Check what ran: `SELECT * FROM schema_migrations ORDER BY version;`.
* A failed migration stops the start (`Migration 00X_… failed: …`) and rolls back that file only; fix it, deploy again.
* Adding one: new file with the next number, never edit an applied one, keep it idempotent where SQL allows (`IF NOT EXISTS`), run `npm run schema:reference` and commit `SCHEMA_REFERENCE.sql` (a test fails otherwise). There is no automatic down-migration: undo with a new forward migration.
* Release 2 added `005_agency_slug` … `009_share_links` (slugs, web sign-in and sessions, rate limits, saved searches, imports, share links).
* Release 3: `012_notifications` (`notifications`, `push_subscriptions`, `brokers.notify_prefs`, agency credits and caps).
* Release 3 starts with `010_lock_public_api` (Supabase's Data API locked out: RLS on every table, no grants for `anon`/`authenticated`; **every new table must `ENABLE ROW LEVEL SECURITY`**, a test fails otherwise) and `011_crm_settings` (`agencies.crm_settings`, `crm_jobs`).

## 3b. Scheduler

* Every instance ticks once a minute; each job runs on one instance (advisory lock + the `crm_jobs` row). On Render Free the service sleeps when idle: jobs catch up once when it wakes.
* State: `SELECT name, last_started_at, last_finished_at, last_status, last_error, run_count FROM crm_jobs ORDER BY name;`
* History: `SELECT operation_type, status, metadata, created_at FROM operation_logs WHERE operation_type LIKE 'crm_job_%' ORDER BY created_at DESC LIMIT 50;`
* Run a job again now: `UPDATE crm_jobs SET last_started_at = NULL, last_status = NULL WHERE name = '<job>';` (it runs on the next tick).

## 4. Onboarding an agency

1. Copy `docs/pilot/agency.example.json`, fill the agency (name, optional `slug` for public links — lower-case letters, digits and dashes — colours, logo `https://` URL) and brokers (name, Egyptian mobile, role `broker`/`admin`/`owner`/`manager`, `lang` `ar`/`en`). At least one admin, owner or manager. Optional `code_prefix` (1–4 Latin letters) sets the agency's unit code letters (`NH` → auto codes `NH-V12`); without it they come from the agency's name and a manager can change them on 📊 My usage. Set `bot_phone` (or `BOT_PHONE`) to the bot's WhatsApp number so `onboard` prints start links. The file's `_notes` explain each field.
2. `npm run onboard -- my-agency.json --dry-run`, then without `--dry-run`. Re-running is safe (agency by name, brokers by phone). It prints the slug, the web app address and each broker's **start link** (`wa.me/<bot>?text=مساعدة`, or `help` for English brokers).
3. Each broker must message the bot once before it can reply: send them their start link (one tap, then send). Then the guides in their language: `docs/pilot/broker-howto-ar.md` and `web-howto-ar.md`, or `broker-howto-en.md` and `web-howto-en.md`.
4. Deactivating a broker: `npm run onboard -- --deactivate my-agency.json 0101…` — the bot stops answering them, their web sessions end at once, their leads go to the unassigned pool and every manager gets one "N leads to reassign" notification (P6). Don't deactivate with a bare `UPDATE brokers SET is_active = false`: their leads would stay with nobody.

## 5. Rotating secrets

| Secret | Steps | Effect |
| :--- | :--- | :--- |
| `WHATSAPP_ACCESS_TOKEN` | Meta Business → System users → generate a new token (permissions `whatsapp_business_messaging`, `whatsapp_business_management`) → update in Render → redeploy → revoke the old one. | Sends fail until the new token is live. |
| `WHATSAPP_APP_SECRET` | Meta app → Settings → Basic → reset the app secret → update in Render at once → redeploy. | Webhooks signed with the new secret get 401 until the deploy is live; Meta retries them. |
| `WHATSAPP_VERIFY_TOKEN` | Change in Render, redeploy, then re-verify the webhook in Meta with the new value. | Only used when (re)subscribing. |
| `GEMINI_API_KEY` | Google AI Studio → create a key in the billed project → update in Render → redeploy → delete the old key. | While no key works, search falls back to the local parser and adding by AI asks to retry. |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project settings → API → roll the key → update in Render → redeploy. | Photo uploads fail until updated. |
| `LEAD_HASH_KEY` | Only if it leaked. Set the new value in Render and redeploy. | Clients erased before the change are no longer recognized on re-capture. |
| `DATABASE_URL` password | Supabase → Database → reset the password → update `DATABASE_URL` → redeploy. | The service cannot start without it. |

Web sign-in has no shared secret to rotate: tokens and sessions are random and stored only as hashes.
* Sign one broker out everywhere: `UPDATE web_sessions SET revoked_at = NOW() WHERE broker_id = '<id>' AND revoked_at IS NULL;`
* Sign everyone out: `UPDATE web_sessions SET revoked_at = NOW() WHERE revoked_at IS NULL;`
* Kill a client share link: `UPDATE share_links SET revoked_at = NOW() WHERE listing_id = '<listing id>';` (all links of that unit).

## 6. Reading `operation_logs`

Every operation writes one row (success or failure): `agency_id`, `broker_id`, `listing_code`, `operation_type`, `status`, `error_code`, timings (`total_duration_ms`, `gemini_ms`, `db_ms`, …), tokens, `model_used`, `estimated_cost_usd`, `metadata` (JSON), `created_at`. **Never delete or truncate it**; it is the audit trail and the AI quota reads it.

Useful `operation_type` values: `search_query` (`metadata.channel` text|voice|web), `search_parse`, `listing_extraction`, `audio_transcription`, `vision_curation` (AI calls with tokens and cost), `draft_review`, `draft_commit`, `listing_edit`, `listing_price_update`, `listing_status_*`, `wa_outbound` (every WhatsApp send), `web_login_link`, `web_login`, `web_unit_create`, `web_unit_edit`, `web_unit_extract`, `web_import_plan`, `web_import_apply`, `web_bulk_edit`, `share_opened`. Release 3: `lead_capture` and `lead_import` (outcome and `L-` reference only, never a name or phone), `web_lead_extract`, `crm_job_<name>` (one row per scheduler run), `bulk_excel_import` (WhatsApp Excel upload), `command_inventory_stats`.

Notification kinds (`notifications.kind`): `assignment`, `follow_up` (reminders, viewings and the 24-hour nudge), `match`, `share_opened`, `hot_client`, `manager_alert` (credits, leads to reassign, retention warnings).

```sql
-- Failures in the last 24 hours
SELECT operation_type, status, error_code, count(*) FROM operation_logs
WHERE created_at > now() - interval '24 hours' AND status NOT IN ('success', 'zero_matches', 'not_search')
GROUP BY 1, 2, 3 ORDER BY 4 DESC;

-- AI cost per agency per day (USD)
SELECT agency_id, date_trunc('day', created_at) AS day, round(sum(estimated_cost_usd)::numeric, 4) AS usd, count(*) AS calls
FROM operation_logs WHERE gemini_ms > 0 GROUP BY 1, 2 ORDER BY 2 DESC, 3 DESC;

-- Search latency (p50 / p90, ms) by channel, last 7 days
SELECT metadata->>'channel' AS channel,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY total_duration_ms) AS p50,
       percentile_cont(0.9) WITHIN GROUP (ORDER BY total_duration_ms) AS p90, count(*)
FROM operation_logs WHERE operation_type = 'search_query' AND created_at > now() - interval '7 days' GROUP BY 1;

-- Web use: sign-ins, units added/edited, imports, client opens per agency (last 30 days)
SELECT agency_id, operation_type, count(*) FROM operation_logs
WHERE created_at > now() - interval '30 days'
  AND operation_type IN ('web_login', 'web_unit_create', 'web_unit_edit', 'web_import_apply', 'share_opened')
GROUP BY 1, 2 ORDER BY 1, 2;

-- Sign-in links that WhatsApp did not deliver (24-hour window closed): the broker should send «دخول»
SELECT broker_id, created_at FROM operation_logs WHERE operation_type = 'web_login_link' AND status <> 'success' ORDER BY created_at DESC LIMIT 20;
```

## 7. Reading `agency_outbound_daily`

The view counts WhatsApp messages the bot sent per agency per Cairo day, from `wa_outbound` rows: `sent` (accepted by WhatsApp) and `failed` (refused, dropped or errored).

```sql
-- This month per agency
SELECT a.name, sum(o.sent) AS sent, sum(o.failed) AS failed
FROM agency_outbound_daily o JOIN agencies a ON a.id = o.agency_id
WHERE o.day >= date_trunc('month', now() AT TIME ZONE 'Africa/Cairo')
GROUP BY 1 ORDER BY 2 DESC;

-- Daily trend for one agency
SELECT day, sent, failed FROM agency_outbound_daily WHERE agency_id = '<id>' ORDER BY day DESC LIMIT 30;

-- What is sent (reply kinds, sign-in links, opened alerts)
SELECT metadata->>'kind' AS kind, count(*) FROM operation_logs
WHERE operation_type = 'wa_outbound' AND created_at > now() - interval '30 days' GROUP BY 1 ORDER BY 2 DESC;
```

Sizing: replies inside the 24-hour window are free up to Meta's monthly allowance per number (about 1,000), then about 0.19 EGP each. Many `failed` rows on one day usually mean an expired access token or brokers outside their 24-hour window (error 131047).

## 7b. Notifications and message credits

* **One notification, one channel.** Each alert is one `notifications` row per broker and event (`UNIQUE (broker_id, dedupe_key)`: never twice). It goes on WhatsApp when the broker chose WhatsApp for that kind (⚙️ Settings), their 24-hour window is open and the agency is below 100% of its credits; otherwise, or when WhatsApp refuses it, as web push; with no push either, it waits in the website inbox (🔔). Alerts of the same kind within 2 minutes go out as one message; quiet hours (default 22:00–08:00 Cairo) hold them until the end. The scheduler job `notifications` releases held and merged ones.
* **Credits:** every accepted WhatsApp send is a `wa_outbound` row (`metadata`: `kind`, `action`, `egp`). At 50/80/100% a one-line hint rides on a reply already being sent (once per broker per level per month); managers get an 80% and 100% alert. At 100% notifications move to the website and replies continue. At the ceiling (110%, the global ceiling, or a broker's cap) a broker gets one notice a day, then only read ticks. Sign-in links have their own ceiling.

```sql
-- Credits used this month per agency (Cairo month), with the estimated cost
SELECT a.name, COALESCE(a.wa_credits_monthly, 4000) AS credits, count(o.*) AS used,
       round(sum((o.metadata->>'egp')::numeric), 2) AS egp
FROM agencies a LEFT JOIN operation_logs o ON o.agency_id = a.id AND o.operation_type = 'wa_outbound' AND o.status = 'success'
 AND o.created_at >= date_trunc('month', now() AT TIME ZONE 'Africa/Cairo') AT TIME ZONE 'Africa/Cairo'
 AND COALESCE(o.metadata->>'kind', '') <> 'web_login_link'
GROUP BY a.id ORDER BY used DESC;

-- Set an agency's credits and caps (NULL = server default / off)
UPDATE agencies SET wa_credits_monthly = 6000, wa_broker_daily_cap = NULL, wa_broker_weekly_cap = 400 WHERE id = '<agency id>';

-- The notification log: who got what, on which channel, why
SELECT n.created_at, b.name, n.kind, n.channel, n.reason, n.status FROM notifications n JOIN brokers b ON b.id = n.broker_id
WHERE n.agency_id = '<agency id>' ORDER BY n.created_at DESC LIMIT 50;
```

**The 10% alarm.** Check weekly: an agency whose month-to-date pace ends the month more than 10% over its credits reaches the hard ceiling (110%) before the month ends, and its brokers drop to read ticks. Raise its credits, or move its heavy work to the website (the CRM guide's "Do these on the website" table), before that happens.

```sql
-- Projected month-end use vs credits; alarm when over 110%
WITH m AS (
  SELECT date_trunc('month', now() AT TIME ZONE 'Africa/Cairo') AS start,
         extract(day FROM now() AT TIME ZONE 'Africa/Cairo') AS day,
         extract(day FROM date_trunc('month', now() AT TIME ZONE 'Africa/Cairo') + interval '1 month - 1 day') AS days
)
SELECT a.name, COALESCE(a.wa_credits_monthly, 4000) AS credits, count(o.*) AS used,
       round(count(o.*) / m.day * m.days) AS projected,
       round(count(o.*) / m.day * m.days / COALESCE(a.wa_credits_monthly, 4000) * 100) AS projected_pct,
       round(sum((o.metadata->>'egp')::numeric), 2) AS egp_so_far
FROM agencies a CROSS JOIN m
LEFT JOIN operation_logs o ON o.agency_id = a.id AND o.operation_type = 'wa_outbound' AND o.status = 'success'
 AND o.created_at >= m.start AT TIME ZONE 'Africa/Cairo' AND COALESCE(o.metadata->>'kind', '') <> 'web_login_link'
GROUP BY a.id, m.day, m.days
HAVING count(o.*) / m.day * m.days > 1.1 * COALESCE(a.wa_credits_monthly, 4000)
ORDER BY projected_pct DESC;
```

* `agencies.crm_settings` (JSON, default `{}`) is reserved for per-agency CRM options; nothing reads it yet, so leave it empty.
* Push subscriptions: `push_subscriptions` (removed when the browser answers 404/410). Turn a broker's push off: `DELETE FROM push_subscriptions WHERE broker_id = '<id>';`

## 7c. Leads (CRM)

* Leads live in `leads` (one row per client per agency; `phones` holds up to 3 numbers), their history in `lead_events` (append-only; an undo is a new event). Names and phones never go to `operation_logs` (`lead_capture` rows carry the outcome and the `L-` reference only).
* Who has what: `SELECT assigned_broker_id, stage, count(*) FROM leads WHERE agency_id = '<id>' GROUP BY 1, 2;`
* A broker leaves: `npm run onboard -- --deactivate <agency.json> <phone>` (see §4).
* **Match alerts:** the `match_sweep` job (every 5 minutes) alerts brokers when a unit newly fits a client's request. Its last run: `SELECT last_started_at, last_status, watermark FROM crm_jobs WHERE name = 'match_sweep';` What a lead was matched with: `SELECT status, count(*) FROM lead_matches WHERE lead_id = '<id>' GROUP BY 1;` Brokers get at most 10 match alerts a Cairo day.
* **Follow-up reminders:** the `follow_up_reminders` job (every minute) reminds brokers of due follow-ups and viewings and nudges once about new leads nobody contacted in 24 hours. Its last run: `SELECT last_started_at, last_status FROM crm_jobs WHERE name = 'follow_up_reminders';` A reminder that didn't come: `SELECT next_follow_up_at, follow_up_status, follow_up_reminded_at, assigned_broker_id FROM leads WHERE ref = <n> AND agency_id = '<id>';` (no assignee means no reminder; a stamped `follow_up_reminded_at` means it went to the inbox, held until quiet hours end if needed). To remind again, set the follow-up again.
* **Client privacy (PDPL):** a client asks for their data: a manager opens the client on the website and taps 📦 Export (a zip; 10 an hour). A client asks to be deleted: a manager types the last 4 digits of the client's number under 🗑️ Erase; this cannot be undone, and deals keep only the unit and the money. The `privacy` job erases clients with no activity for 18 months (managers get a warning 30 days before) and clears stored WhatsApp payloads after 7 days. Its last run: `SELECT last_started_at, last_status FROM crm_jobs WHERE name = 'privacy';` Never clear `operation_logs`; it holds no client names or numbers.
* **Importing a client list:** `/app/leads/import` (CSV or Excel, up to 2,000 rows; template at `/app/leads/import/template.xlsx`). The preview writes nothing; Import runs in the background, so the broker can leave the page. A stuck import: `SELECT id, status, result FROM web_imports WHERE kind = 'leads' ORDER BY created_at DESC LIMIT 5;` — a restart mid-way leaves it `processing` with `result.done` rows saved (each row is its own transaction, so nothing is half-written); the rest is re-imported by uploading the same file again (already-saved rows show as merges).
* **Share target:** on Android, once the site is installed, WhatsApp's Share menu offers AqarChat; the shared text opens `/app/share` → the add-lead form (nothing is saved until the broker taps Save). The text travels in the URL (GET), so it can appear in the browser history of that phone.

## 7d. Switching to the backup number

If Meta blocks or restricts the bot's number:
1. In WhatsApp Manager add the backup number to the same WhatsApp Business account, verify it and give it the display name.
2. Set `WHATSAPP_PHONE_NUMBER_ID` to the new number's id (and `BOT_PHONE` to the number) in Render; redeploy. The access token and webhook stay the same.
3. Run `npm run onboard -- <agency.json>` again for each agency: it changes nothing in the data and prints new start links. Send each broker theirs: the bot can't write first on a new number (no 24-hour window yet).
4. Old client share links keep working (they point at the website, not the number). Approved message templates belong to the account, not the number.

## 8. Common problems

| Symptom | Cause and fix |
| :--- | :--- |
| `Startup failed: Missing required environment variables: …` | Set the named variables in Render and redeploy. |
| Webhooks answer 401 | `WHATSAPP_APP_SECRET` does not match the Meta app. |
| Brokers get no reply | Check `/health`, then Logs; `wa_outbound` rows with `failed`; the broker may be inactive or unregistered (they get the "not registered" notice once a day). |
| "حد الذكاء الاصطناعي اليومي" messages | The daily AI quota is spent (`AI_QUOTA_*`) or Gemini billing is off. |
| A sign-in link never arrives (web form) | The broker's 24-hour WhatsApp window is closed; they send «دخول» to the bot instead. |
| A shared link shows "الصفحة غير موجودة" | Wrong or revoked link, or the unit's code changed; share a new one. Sold units show "مبقتش متاحة". |
| Web forms answer "Cross-site request refused" (403) | The browser's address differs from `PUBLIC_BASE_URL` (e.g. the custom domain is live but the variable still names onrender.com). Set `PUBLIC_BASE_URL` to the address brokers open. |
| Flyer requests time out | Worker queue full (`FLYER_MAX_QUEUE`) or a slow render (`FLYER_TIMEOUT_MS`); check memory. |

## 9. Before Release 4

**Submit the Meta message templates now** (Meta Business → WhatsApp Manager → Message templates): the Release 4 morning brief and the "still available?" check are sent outside the 24-hour window, which only approved templates allow, and approval can take days. Submit:
* the morning brief and the "still available?" check (Release 4);
* **utility** templates for the follow-up reminder and the match alert, for brokers who chose WhatsApp for those notifications, so they arrive even when the broker hasn't written to the bot for 24 hours (today they fall back to web push or the inbox).
