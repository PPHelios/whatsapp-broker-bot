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
| `WHATSAPP_API_VERSION` | no | `v20.0` | Graph API version. |
| `GEMINI_API_KEY` | yes | — | Production Gemini key (billing on, budget alert set). The eval never uses it. |
| `SUPABASE_URL` | yes for photos | — | Storage project URL (bucket `listing-images`). Without it storage runs in a mock mode: photos are not kept. |
| `SUPABASE_SERVICE_ROLE_KEY` | yes for photos | — | Storage key (server only; never in the browser). `SUPABASE_ANON_KEY` is a fallback. |
| `MALLOC_ARENA_MAX` | no | `2` (blueprint) | Keeps flyer rendering around 250 MB peak RSS. |
| `PORT` | no | `3000` | Render sets it. |
| `MIGRATE_ON_BOOT` | no | `true` | `false` skips migrations at start (then run `npm run migrate` by hand). |
| `DB_POOL_MAX` / `DB_STATEMENT_TIMEOUT_MS` / `DATABASE_SSL` | no | `10` / `10000` / on in production | Pool size, statement timeout, SSL. |
| `BODY_LIMIT` | no | `512kb` | JSON and form bodies (uploads have their own limits: 10 MB a photo, 5 MB an Excel file). |
| `AI_QUOTA_AGENCY_DAILY` / `AI_QUOTA_BROKER_DAILY` | no | `2000` / `400` | Daily AI calls; over the limit the broker is told and nothing is lost. |
| `AI_PRICES_JSON` | no | built-in | Model prices for the cost column, e.g. `{"gemini-3.8-flash":{"inPerM":0.3,"outPerM":2.5}}`. |
| `FLYER_WORKER` / `FLYER_MAX_QUEUE` / `FLYER_TIMEOUT_MS` | no | on / `6` / `45000` | Flyer rendering worker thread. |
| `SLOW_QUERY_MS` | no | `1000` | Slow-query log threshold. |
| `WEBHOOK_ALLOW_UNSIGNED` | no | — | Local development only; ignored in production. |

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

## 4. Onboarding an agency

1. Copy `docs/pilot/agency.example.json`, fill the agency (name, optional `slug` for public links — lower-case letters, digits and dashes — colours, logo `https://` URL) and brokers (name, Egyptian mobile, role `broker`/`admin`/`owner`/`manager`, `ar`/`en`). At least one admin, owner or manager.
2. `npm run onboard -- my-agency.json --dry-run`, then without `--dry-run`. Re-running is safe (agency by name, brokers by phone). It prints the slug and the web app address.
3. Each broker must message the bot once (e.g. «مساعدة») before it can reply. Send them `docs/pilot/broker-howto-ar.md` and then `docs/pilot/web-howto-ar.md`.
4. Deactivating a broker: `UPDATE brokers SET is_active = false WHERE phone_normalized = '2010…';` — the bot stops answering them and their web sessions end at once.

## 5. Rotating secrets

| Secret | Steps | Effect |
| :--- | :--- | :--- |
| `WHATSAPP_ACCESS_TOKEN` | Meta Business → System users → generate a new token (permissions `whatsapp_business_messaging`, `whatsapp_business_management`) → update in Render → redeploy → revoke the old one. | Sends fail until the new token is live. |
| `WHATSAPP_APP_SECRET` | Meta app → Settings → Basic → reset the app secret → update in Render at once → redeploy. | Webhooks signed with the new secret get 401 until the deploy is live; Meta retries them. |
| `WHATSAPP_VERIFY_TOKEN` | Change in Render, redeploy, then re-verify the webhook in Meta with the new value. | Only used when (re)subscribing. |
| `GEMINI_API_KEY` | Google AI Studio → create a key in the billed project → update in Render → redeploy → delete the old key. | While no key works, search falls back to the local parser and adding by AI asks to retry. |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project settings → API → roll the key → update in Render → redeploy. | Photo uploads fail until updated. |
| `DATABASE_URL` password | Supabase → Database → reset the password → update `DATABASE_URL` → redeploy. | The service cannot start without it. |

Web sign-in has no shared secret to rotate: tokens and sessions are random and stored only as hashes.
* Sign one broker out everywhere: `UPDATE web_sessions SET revoked_at = NOW() WHERE broker_id = '<id>' AND revoked_at IS NULL;`
* Sign everyone out: `UPDATE web_sessions SET revoked_at = NOW() WHERE revoked_at IS NULL;`
* Kill a client share link: `UPDATE share_links SET revoked_at = NOW() WHERE listing_id = '<listing id>';` (all links of that unit).

## 6. Reading `operation_logs`

Every operation writes one row (success or failure): `agency_id`, `broker_id`, `listing_code`, `operation_type`, `status`, `error_code`, timings (`total_duration_ms`, `gemini_ms`, `db_ms`, …), tokens, `model_used`, `estimated_cost_usd`, `metadata` (JSON), `created_at`. **Never delete or truncate it**; it is the audit trail and the AI quota reads it.

Useful `operation_type` values: `search_query` (`metadata.channel` text|voice|web), `search_parse`, `listing_extraction`, `audio_transcription`, `vision_curation` (AI calls with tokens and cost), `draft_review`, `draft_commit`, `listing_edit`, `listing_price_update`, `listing_status_*`, `wa_outbound` (every WhatsApp send), `web_login_link`, `web_login`, `web_unit_create`, `web_unit_edit`, `web_unit_extract`, `web_import_plan`, `web_import_apply`, `web_bulk_edit`, `share_opened`.

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

## 8. Common problems

| Symptom | Cause and fix |
| :--- | :--- |
| `Startup failed: Missing required environment variables: …` | Set the named variables in Render and redeploy. |
| Webhooks answer 401 | `WHATSAPP_APP_SECRET` does not match the Meta app. |
| Brokers get no reply | Check `/health`, then Logs; `wa_outbound` rows with `failed`; the broker may be inactive or unregistered (they get the "not registered" notice once a day). |
| "حد الذكاء الاصطناعي اليومي" messages | The daily AI quota is spent (`AI_QUOTA_*`) or Gemini billing is off. |
| A sign-in link never arrives (web form) | The broker's 24-hour WhatsApp window is closed; they send «دخول» to the bot instead. |
| A shared link shows "الصفحة غير موجودة" | Wrong or revoked link, or the unit's code changed; share a new one. Sold units show "مبقتش متاحة". |
| Flyer requests time out | Worker queue full (`FLYER_MAX_QUEUE`) or a slow render (`FLYER_TIMEOUT_MS`); check memory. |

## 9. Before Release 4

**Submit the Meta message templates now** (Meta Business → WhatsApp Manager → Message templates): the Release 4 morning brief and the "still available?" check are sent outside the 24-hour window, which only approved templates allow, and approval can take days.
