# ARCHITECTURE_MANIFEST.md
## Canonical System Architecture & Operational Invariants

### 1. Platform Infrastructure & Render Hosting Constraints
* **Ephemeral Filesystem:** Render web service instances run on ephemeral disks. Local disk writes to `/tmp` or project subdirectories are strictly prohibited.
  - Image normalization via Sharp must accept an in-memory `Buffer` and return a compressed `Buffer` directly to Supabase Storage.
  - Excel ingestion and rejection workbooks must be handled entirely in-memory using Node.js streaming buffers (`stream.PassThrough` or `Buffer.from`).
  - System fonts (`Cairo-Bold.ttf`, `Cairo-Regular.ttf`) must be pre-warmed into process memory on server boot via `Flyer.loadFont(...)`.
* **App Factory & Bootstrap:** `server.js` exports `createApp({ pool, config })`, which builds the Express app and the message pipeline around an injected pg-compatible pool. It returns `{ app, state, handleWebhookBody, handleInboundMessage, dispatchMessage, bootRecovery, preWarmAssets }`. Only `start()` creates the real pool (`lib/db.js` `getPool()`), applies pending migrations, binds the port and installs signal handlers, and it runs only when `server.js` is executed directly (`require.main === module`).
* **Configuration (`config.js`):** the single source of runtime configuration. `getConfig()` loads it once from `process.env`; `loadConfig(env)` builds it from any map (tests).
  - **Fails fast in production:** `NODE_ENV=production` refuses to start without `DATABASE_URL`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `GEMINI_API_KEY` and `PUBLIC_BASE_URL` (`REQUIRED_IN_PRODUCTION`), and requires `PUBLIC_BASE_URL` to be `https://`. On Render, `RENDER_EXTERNAL_URL` (set by the platform to `https://<service>.onrender.com`) stands in while `PUBLIC_BASE_URL` is unset; `PUBLIC_BASE_URL` always wins.
  - **Links:** `publicUrl(path)` builds every absolute URL from `PUBLIC_BASE_URL` (trailing slash dropped; `http://localhost:<PORT>` outside production). Use `https://<service>.onrender.com` until the domain exists, then `https://www.aqarchat.com`; changing the variable moves every link.
* **Links (`lib/links.js`):** every absolute link the app sends out (WhatsApp messages, OG tags) is built here from `config.publicUrl`: `appUrl(path, query)` (`/app/...`), `loginLinkUrl(token)`, `searchUrl(filters)`, `unitAppUrl(code)`, `unitPageUrl(slug, code, shareToken)` (`/<agency-slug>/<unit-code>?s=<token>`). Pages inside the site link with relative paths. A test fails if any other module reads `PUBLIC_BASE_URL` or hardcodes the host (`onrender.com`, `aqarchat.com`, `localhost:<port>`).
  - **AI prices and quotas:** `ai.prices` (USD per 1M tokens per model, overridable with `AI_PRICES_JSON`) drive `estimateCostUsd(model, in, out)`, the only cost formula; `ai.quotas` (`AI_QUOTA_AGENCY_DAILY`, `AI_QUOTA_BROKER_DAILY`) feed `checkAiQuota`.
  - Also: `bodyLimit` (`BODY_LIMIT`, default 512kb), `whatsapp.allowUnsigned` (only outside production with `WEBHOOK_ALLOW_UNSIGNED=true`), `db.*` (`DB_POOL_MAX`, `DB_STATEMENT_TIMEOUT_MS` default 10 s, `DATABASE_SSL`, `MIGRATE_ON_BOOT`), `flyer.*` (`FLYER_WORKER`, `FLYER_MAX_QUEUE`, `FLYER_TIMEOUT_MS`).
* **Single pool (`lib/db.js`):** `createPool()` is the only place a `pg.Pool` is created. It sets `statement_timeout`, SSL and type parsers that return NUMERIC (1700) and INT8 (20) as JS numbers (`TYPE_OVERRIDES`); the PGlite harness mirrors the same parsers. `getPool()` is the lazily created process pool used by `start()` and the scripts.
* **Migrations (`db/migrations/`, `lib/migrate.js`):** files named `NNN_name.sql` (one script) or `NNN_name.js` (exports `up(client)` for backfills that need application code) are applied in order, each in its own transaction, and recorded in `schema_migrations`. A session advisory lock (`727001`) serializes concurrent boots. `start()` runs them on boot unless `MIGRATE_ON_BOOT=false`; `npm run migrate` (`scripts/migrate.js`) runs them by hand. Migrations are forward-only and must be idempotent where the statement allows (`IF NOT EXISTS`).

  | Migration | What it does |
  | :--- | :--- |
  | `001_outbound_message_counts.sql` | `agency_outbound_daily` view (sent/failed WhatsApp messages per agency per Cairo day) |
  | `002_listing_data_model.sql` | structured delivery, feature keys, resale schedule, `confirmed_at`, `market`, `finishing`, `furnishing`, `floor_level`, `version`, generated `code_norm` + unique `(agency_id, code_norm)`; backfills; drops the invented `payment_frequency`/`maintenance_pct` defaults (F1) |
  | `003_backfill_feature_keys.js` | `feature_keys`/`features_other` from legacy free text through `domain/features.js` |
  | `004_search_document.js` | one normalizer and one search trigger (D1/D2), `compound_synonyms` and `search_vocabulary` seeded from the domain dictionaries, place key columns |
  | `005_agency_slug.sql` | `agencies.slug` (NOT NULL, unique, URL-safe, not reserved): derived from the name by `agency_slug_base` + trigger `trg_agencies_slug` (−2, −3 on clashes), backfilled oldest first |
  | `006_web_auth.sql` | `web_login_tokens`, `web_sessions` (SHA-256 hashes only) and `web_rate_limits` for the web app |
  | `007_saved_searches.sql` | `saved_searches` (per broker, agency-scoped; `seen_ids` for the "new" count) |

* **Non-Blocking Port Binding:** The HTTP server (`app.listen`) must bind immediately to `process.env.PORT` to satisfy Render health probes within the platform's timeout window. Heavy initialization tasks (font loading, recovery routines) must run asynchronously in the background.
* **Graceful Termination & Drain Protocol:** On `SIGTERM` or `SIGINT`, the service enters a draining state:
  - Halts acceptance of new incoming webhooks (returns HTTP 503 so Meta Graph retries).
  - Permits up to 25 seconds for in-flight tasks (`inFlight > 0` and per-broker queues) to finish executing and write logs before closing the `pg.Pool`.
* **Zero-Downtime Multi-Pod Concurrency:** Because Render runs concurrent containers during blue/green deploys, all unit mutations (edits, deletions, status transitions) must acquire distributed PostgreSQL transactional advisory locks:
  `SELECT pg_advisory_xact_lock(('x' || substr(md5($1 || ':' || $2), 1, 16))::bit(64)::bigint)` using `[String(agency_id), String(code).toUpperCase()]`.

---

### 2. Verified Database Schema & Data Contracts
The database runs on PostgreSQL (Supabase) with the `pg_trgm`, `pgcrypto` and `uuid-ossp` extensions.

**Source of truth:** the schema the app runs on is **`db/schema.sql` + `db/migrations/*`**.
* `db/schema.sql` is the **baseline**: the live catalog exported before Release 1 by `npm run schema:export` (`scripts/export-schema.js`, READ ONLY transaction). It is never edited by hand, and schema changes are never made by re-exporting it: every change is a new migration.
* `SCHEMA_REFERENCE.sql` is the **full reference after every migration**: extensions, sequences, functions, tables (with generated columns), constraints, indexes, triggers and views. `npm run schema:reference` (`scripts/schema-reference.js`) builds it offline from PGlite (baseline + migrations) with the same exporter. It has no timestamp, and `tests/unit/schema-reference.test.js` fails when it is stale, so every migration commit regenerates it. Read it to know a column or index; never apply it.
* The test database is built exactly like production: baseline, then the migrations (`tests/harness/db.js`).

#### A. Core Tables & Identity
* **`agencies`**: Stores multi-tenant agencies (`id`, `name`, `slug`, `logo_url`, `primary_color`, `secondary_color`, `flyer_theme`, `phone`). Created and updated by onboarding (§7.E).
  - `slug` is the first path segment of public unit pages. It is derived once from the Latin letters and digits of the name (`domain/slug.js` `baseSlug`, SQL twin `agency_slug_base`; Arabic-only or reserved names get `agency-<id prefix>`), or set in the onboarding file, and it never changes on rename, so shared links survive. Reserved first segments (`RESERVED_SLUGS`: app, api, auth, webhook, health, static, …) can never be slugs.
* **`brokers`**: Identity and WhatsApp phone mapping.
  - *Invariant:* Always reference `brokers.phone_number` and `brokers.phone_normalized`. Lookups must match against `phone_normalized`.
  - Columns: `id`, `agency_id`, `name`, `phone_number`, `phone_normalized`, `contact_phone`, `role`, `is_active`, `preferred_lang`, `last_active_at`.
* **`projects`**: Master developer portfolios (`id`, `agency_id`, `name`, `developer_name`, `location`, `district`, `city`, `collateral`, `media`).

#### B. Inventory & Media
* **`listings`**: The core inventory store.
  - Columns: `id`, `agency_id`, `broker_id`, `project_id`, `code`, `title`, `property_type`, `listing_type`, `price_value`, `price_display`, `area_value`, `bedrooms`, `location`, `compound`, `district`, `city`, `location_keywords`, `status`, `is_primary_developer`, `inventory_type`, `developer_unit_code`, `down_payment_value`, `installment_years`, `installment_value`, `payment_frequency`, `delivery_date`, `maintenance_pct`, `bathrooms`, `compound_en`, `search_text_normalized`, `details`, `payment_terms`, `collateral`, `flyer_cache`.
  - **Release 1 columns (migration 002/004):**
    - Delivery: `delivery_year`, `delivery_quarter` (1–4), `delivery_month` (1–12), `is_ready`, `delivery_raw` (what the broker said). The legacy `delivery_date` text is no longer written.
    - Features: `feature_keys text[]` (fixed bilingual keys from `domain/features.js`) and `features_other text[]` (free-text extras).
    - Resale schedule: `down_payment_value` (paid), `remaining_amount`, `installment_value`, `payment_frequency` (`monthly|quarterly|semi_annual|annual`), `installments_end` (date). Years left is computed when shown, never stored.
    - `market` (`resale|primary`), `finishing` (key), `furnishing` (`furnished|semi_furnished|unfurnished`), `floor_level` (0 = ground).
    - `confirmed_at`: when a broker last vouched for the unit (insert, any edit or quick update).
    - `version`: optimistic-lock counter, +1 on every patch (§7.C).
    - `code_norm`: generated `upper(trim(code))` with Eastern digits folded; unique per agency (`uq_listings_agency_code_norm`). Every code lookup uses it (B6/B7).
    - `compound_key`, `developer_key`, `area_key`: language-neutral place keys set by the search trigger.
  - *Primary payment terms:* `payment_terms = { plans: [{ plan_id, down_payment_pct, years, frequency, delivery_pct, milestones }], cash_price, maintenance_terms, maintenance: { pct, due: delivery|installments } }` (maintenance terms are data, Q-F). Unknown maintenance reads "حسب التعاقد", never an invented 8% (F1).
  - *Details JSONB Contract:* Stores auxiliary attributes (`finishing`, `finishing_en`, `floor`, `nanny_room`, `driver_room`, `has_master_bedroom`, `has_dressing_room`, `ready_to_move`, `bua`, `land_area`, `roof_area`, `garden_area`, `villa_type`, `image_order`, `description_ar`, `summary_ar`, `total_upfront_cash`, `remaining_debt`, `over_price`).
  - *Missing Attribute Rule:* Missing fields must be stored as explicit SQL `NULL`. Default values (e.g., assuming "Fully Finished" or "2029") are forbidden.
  - *Mutation Cascade Rule:* every edit goes through `applyListingPatch` (§7.C), which sets `version = version + 1`, `confirmed_at = now()`, `updated_at = now()` and `flyer_cache = '{}'`. The `trg_listings_search_document` trigger rebuilds `search_text_normalized` and the place keys on every insert and update. Curated photo orders and roles in `listing_images` are preserved.
* **`listing_images`**: Individual listing media records.
  - Columns: `id`, `listing_id`, `agency_id`, `position`, `url`, `phash`, `role`.
  - Roles: `facade`, `reception`, `master_bedroom`, `bedroom`, `kitchen`, `bathroom`, `terrace`, `garden`, `compound_amenity`, `document`, `other`.

#### C. State, Telemetry & Ingress
* **`broker_sessions`**: Distributed state machine replacing ephemeral in-memory Maps.
  - *Composite Primary Key:* `(broker_id, session_type)`
  - Columns: `broker_id` (UUID), `session_type` (VARCHAR), `session_data` (JSONB), `expires_at` (TIMESTAMPTZ).
  - *Schema Invariant:* Does NOT contain `id` or `updated_at`. Mutation queries must never reference `updated_at`.
  - *TTL Invariant:* Draft and edit sessions enforce a strict 15-minute sliding expiration window (`expires_at = NOW() + INTERVAL '15 minutes'`).
* **`operation_logs`**: Symmetrical telemetry and dynamic latency audit tracking.
  - Columns: `id`, `agency_id`, `broker_id`, `listing_code`, `operation_type`, `status`, `error_code`, `total_duration_ms`, `gemini_ms`, `media_download_ms`, `image_process_ms`, `flyer_render_ms`, `storage_upload_ms`, `db_ms`, `tokens_input`, `tokens_output`, `model_used`, `estimated_cost_usd`, `created_at`, `metadata`.
* **`inbound_messages`**: Webhook deduplication and startup crash recovery.
  - Columns: `msg_id` (PK), `phone_key`, `payload`, `status`, `attempts`, `received_at`, `updated_at`.
* **`processed_batches`**: Multi-tap mutation idempotency (`batch_key`, `agency_id`, `listing_code`).
* **`schema_migrations`**: applied migration versions (`version`, `applied_at`).
* **`compound_synonyms`** (`kind` compound|developer|area, `key`, `synonym`, `synonym_norm`, `area_key`, `developer_key`) and **`search_vocabulary`** (`kind` type|feature, `key`, `terms`): reference data seeded by migration 004 from `domain/places.js`, `domain/features.js` and `domain/vocabulary.js`. The test harness keeps them across `TRUNCATE`.
* **`web_login_tokens`** (`token_hash` PK, `broker_id`, `agency_id`, `channel` whatsapp|web, `created_at`, `expires_at`, `used_at`): one-time magic-link tokens, 15 minutes.
* **`web_sessions`** (`id_hash` PK, `broker_id`, `agency_id`, `csrf_token`, `user_agent`, `created_at`, `last_seen_at`, `expires_at`, `revoked_at`): 30-day web sessions.
* **`web_rate_limits`** (`bucket`, `window_start`, `hits`): fixed-window counters shared by all pods.
* **`saved_searches`** (`id`, `agency_id`, `broker_id`, `name`, `filters` jsonb = canonical filters, `seen_ids uuid[]`, `created_at`, `last_run_at`): a broker's saved web searches (Release 3 adds `lead_id`).
* **`agency_outbound_daily`** (view): `agency_id`, `day` (Africa/Cairo), `sent`, `failed`, counted from `operation_logs` rows with `operation_type = 'wa_outbound'` (§5).
#### D. Domain Responsibility Partitioning (State & Ingress)
* **`lib/drafts.js` Contract (review → staged commit):**
  - Manages session lifecycle inside `public.broker_sessions` (composite key `[broker_id, session_type]`, 15-minute sliding TTL).
  - Inputs (`appendText`, `appendVoice`, `appendMedia`) clear any staged review, so only a review of the current inputs can be committed.
  - `reviewDraft` (DRF-02): `L.extractPropertyDetails` over every text and voice note → `L.composeFields` → `domain/fieldRules.evaluate` → `stageDraftReview` stores `{ ok, fields, code, warnings, blockers, inputs, model }` as `session_data.staged_review` and replies with `Describe.reviewCard` (the only surface that shows warnings). The Confirm button is offered only when `ok`.
  - `commitStagedReview` (DRF-03, `draft_confirm`): in one transaction, consumes the draft (`DELETE … RETURNING`, so a double tap saves once), refuses anything but an `ok` staged review (re-reviews instead), and **inserts only** through `listingStore.createListing` (the one insert path, shared with the web form and imports): a stated code that exists (`23505` on `uq_listings_agency_code_norm`) rolls back, keeps the draft and replies "الكود مستخدم"; a generated code that collides is regenerated under a savepoint. `commitDraftToDatabase`/`commitDraftToListing` are kept as contract names for the same path.
  - Photos are uploaded to storage at ingest (`routes/media.js`); the draft keeps the URL (base64 only when that upload failed) and the commit links them in `listing_images` (`role = NULL`), deferring vision curation to the first flyer render.
* **`lib/listing.js` (Pure Extraction & Parsing):**
  - `buildListingPrompt` (fenced input), `extractPropertyDetails` (one `listing_extraction` call through the AI gateway), `normalizeExtraction` (AI JSON → columns + `details` + `payment_terms`; never fills a field the AI left empty), `findStatedCode`.
  - `composeFields({ existing, draft })`: a stated value wins, an unstated one keeps the existing value; delivery is replaced as a unit; features are merged; villas drop the floor and keep BUA; studios get 0 bedrooms; commercial units none. `LISTING_COLUMNS` lists the top-level columns it owns.
  - Does NOT perform database I/O or commit transactions directly.

---

### 3. AI Gateway & Resilience Architecture
* **Single gateway:** every Gemini call goes through `lib/ai.js` `generateWithCascade({ contents, config, operationType, ctx })`. That covers search parsing, transcription, vision curation and draft extraction, which makes it the only place that controls AI latency, cost and telemetry. All calls pass through the in-process `rateGate` (60 RPM per process).
* **Model tiers (`TIERS`, in order):** `gemini-3.8-flash` → `gemini-3.6-flash` → `gemini-3.5-flash-lite`.
* **Per-task routes (`ROUTES`):** each `operationType` has a total `deadlineMs`, a `hedgeAfterMs`, and a thinking class. Unknown types use `default`.

  | Route | Deadline | Hedge after | Thinking |
  | :--- | :--- | :--- | :--- |
  | `search_parse` | 8 s | 3.5 s | fast |
  | `audio_transcription` | 25 s | 8 s | fast |
  | `vision_curation` | 45 s | 15 s | fast |
  | `default` (draft extraction and others) | 40 s | 12 s | model default |

* **Hedged failover:**
  - If the current tier hasn't answered within `hedgeAfterMs`, the next tier starts **in parallel**. The first successful answer wins, and the other attempts are cancelled through `abortSignal`.
  - A hard error (overloaded, quota, invalid) moves to the next tier immediately, with no fixed sleeps.
  - The call fails with `code: "AI_DEADLINE"` when the route deadline passes.
* **Thinking per model (`FAST_THINKING`):** thinking settings aren't portable across models. `gemini-3.8-flash` rejects `MINIMAL`, and flash-lite rejects `thinkingBudget: 0` (probed 2026-10-24). So the "fast" class maps each model to its own lowest accepted level: 3.8 → `LOW`, 3.6 and lite → `MINIMAL`. Draft extraction keeps the model default until the AI quality eval (`npm run eval:ai`) shows a lower level keeps accuracy.
* **Telemetry:**
  - Each call writes one `operation_logs` row, on success **and** on failure. It records `operation_type = <route>`, the winning `model_used`, `gemini_ms` (the winner's latency), `total_duration_ms` and `tokens_input`.
  - `tokens_output` includes thinking tokens, because they're billed as output.
  - `metadata.thoughts_tokens` holds the thinking-token count, and `metadata.attempts` lists every attempt with `{ model, startedMs, ms, outcome: ok|aborted|overloaded|quota|timeout|invalid|other, error }`.
* **Deterministic Lexical Search Fallback:** any search-parse failure falls back to `S.fallbackParse(text)` using local regex extraction, so search queries never fail. That includes the AI client failing to load, and the 8 s deadline.
* **Dynamic ESM Loading:**
  - The `@google/genai` library must be imported via a dynamic `await import("@google/genai")` singleton to prevent CommonJS `ERR_REQUIRE_ESM` runtime crashes.
  - Tests inject a fake client with `_setClientForTests`.
* **Quality eval (manual, not CI):**
  - `npm run eval:ai -- --model <model> --configs A,B,C,D,E` scores real Gemini extractions of the recorded broker voice notes (`tests/eval/cases.json`, scorer `tests/eval/score.js`). It reports field accuracy and latency per thinking level and pipeline.
  - Recordings and results stay local, in `tests/eval/audio/` and `tests/eval/results/`; both are gitignored.
  - Results are saved after every case, and a rerun resumes.
  - **Key safety:** the eval never uses the production `GEMINI_API_KEY`. `--key-env KEY_A,KEY_B` names keys from separate Google AI Studio projects, because daily free-tier limits are per project. The runner refuses to start on the production key, and when one key hits its daily limit it moves to the next.
  - `--rescore` re-applies the scorer to stored outputs without calling the API, e.g. after a scorer fix.

---

### 4. Media Ingress & Lazy Vision Curation
* **Ingress Normalization:**
  - Raw image buffers are normalized immediately via Sharp: auto-rotated via EXIF, bounded to $1600 \times 1600$ inside without enlargement, and encoded to JPEG Q82.
  - Sharp concurrency is restricted to 1 worker thread with a 64MB memory ceiling.
* **15-Image Ingress Ceiling:**
  - Listings are capped at 15 photos maximum. Any incoming images beyond 15 are dropped, and an immediate WhatsApp warning notification accompanied by action buttons is sent to the broker.
* **Lazy Vision Curation Workflow:**
  - *Ingestion Phase (Zero Vision):* Images are stored with raw positions ($1 \dots 15$) and `role = NULL`. No vision tokens are consumed at draft save time.
  - *Trigger Phase (On-Demand):* On the first brochure request (`renderFlyerOnDemand`), if unclassified images exist, Sharp creates 768px in-memory thumbnails ($768 \times 768$ native 1-tile resolution).
  - *Creative Director Directives:*
    1. **Hero Image:** Evaluates and selects the single best wide-angle exterior facade or living reception. Bathrooms, kitchens, hallways, and text documents are strictly barred from being the cover hero.
    2. **Diversity Quotas:** Enforces room diversity across up to 9 photos (max 2 reception, 2 bedrooms, 1 kitchen, 1 terrace) and drops repetitive angles.
    3. **Document Filtering:** Filters out payment schedules, blurry shots, and contract screenshots.
  - *Persistence:* Curated roles and `image_order` are committed to `listing_images` and `listings.details`. Subsequent flyer renders read directly from PostgreSQL.
* **Flyer Rendering Canvas:**
  - Luxury flyers are rendered exclusively in **100% English LTR**. The `arabic-persian-reshaper` library is strictly deprecated and barred from imports.

---

### 5. Conversational UX, WhatsApp Limits & Symmetrical Messaging
* **Zero Silent Drops:** Every code branch (success, validation failure, DB error, expired session, unsupported media) must return an explicit WhatsApp response. Silence is strictly prohibited.
* **Single Outbound Path & Delivery Truth:**
  - Handlers send only through `lib/dispatcher.js`: `reply`, `replyButtons`, `replyList`, `replyImage`, `replyDocument` and `react`; messages outside a turn (web sign-in links, opened alerts) use `notify(broker, text, { pool, kind })`, which goes through the same `deliver()` and counter. They never call `WA.send*` directly; a test in `tests/unit/whatsapp-client.test.js` enforces this.
  - A turn counts as answered **only after WhatsApp accepts the message**, i.e. a non-null result. A failed or dropped send leaves the turn unanswered, so `executeGuardedTurn`'s safety net still replies.
  - A delivered 📸 reaction answers a photo turn.
  - The single exception is the unregistered-number notice in `server.js`, which runs outside any broker turn.
* **Outbound message counter:** `deliver()` in `lib/dispatcher.js` writes one `operation_logs` row per send attempt (`operation_type = 'wa_outbound'`, `status` success|dropped|failed, `metadata.kind` = the reply helper) with the turn's pool. The `agency_outbound_daily` view sums them per agency and Cairo day, so the WhatsApp pool can be sized against Meta's pricing tiers (about 0.19 EGP per reply after 1,000 free a month per number).
* **One message per task:** quick updates, search and the flyer each answer in one message (the flyer is one image with a caption). Button ids and titles come from `lib/buttons.js`; the copy of the Release 1 messages comes from `lib/copy.js` (§7.C).
* **Background Deliverables:** Work that finishes after the turn (exports, comparison workbooks, flyers, rejection sheets) must check the dispatcher result and send an explicit error reply when delivery fails.
* **Webhook Batching:** `handleWebhookBody` processes **every** message in every entry and change of a webhook POST, in order (`handleInboundMessage` per message). Bodies with statuses only are ignored.
* **Unregistered Numbers:** A number with no active broker gets one bilingual registration notice per 24 hours, counted from `inbound_messages`. All of its messages are still recorded.
* **No Duplicate Sends:** `postWhatsAppApi` retries only explicit HTTP 429/5xx responses. A POST that times out or loses its connection is **not** re-sent, because it may already have been delivered.
* **WhatsApp Interactive Constraints:**
  - Quick-reply buttons (`interactive: button`) are capped at a maximum of **3 buttons** and **20 UTF-8 characters** per title.
  - For options exceeding 3 (e.g., developer payment plans), the system switches to **Interactive List Menus** (up to 10 rows, 24-character title, 72-character description) or direct text commands.
  - **Meta 24-Hour Expiration Intercept:** If Meta returns error code `131047` (customer service window closed), `postWhatsAppApi` intercepts the response, halts all retry loops immediately, and logs the dropped message to prevent outbound queue blacklisting.
* **Draft vs. Search Collision Guard (COL-01):** If a broker has an active draft and sends a query with search keywords, the system intercepts the text and stores it server-side in `broker_sessions` (`session_type = 'pending_search'`, 15-minute TTL). It then presents an interactive prompt with the fixed button ids `cancel_and_search` and `draft_edit`; button ids are capped at 128 chars, so the query never goes inside the id. Legacy `cancel_and_search:<base64>` buttons are still decoded.
* **Dynamic Median ETAs & Cooldowns:**
  - Resource-intensive actions (brochure rendering, full exports) dispatch an immediate acknowledgment message citing realistic rolling median execution times (calculated from `operation_logs`).
  - Cooldowns are enforced across heavy actions (e.g., 60s for full agency Excel export, 20s for brochure rendering, 45s per agency bulk upload).

---

### 6. Security & Authorization Directives
* **SEC-01 (Webhook Verification):** Inbound webhooks must verify Meta's `X-Hub-Signature-256` HMAC-SHA256 signature against `WHATSAPP_APP_SECRET` using `crypto.timingSafeEqual`.
* **SEC-02 (Tenant Isolation):** Every database read, update, search, and delete query must be strictly scoped to `agency_id = $1`.
* **SEC-03 (Two-Phase Row & Advisory Locks):** Deletions and status transitions must acquire a 64-bit transactional advisory lock and a row lock (`FOR UPDATE`) inside a transaction and re-evaluate `canEdit(broker, listing)` under lock.
* **Authorization (`lib/authz.js`):** the single copy of the rules. `canView` requires the same agency; `canEdit` requires the same agency and either ownership (`listing.broker_id = broker.id`) or a manager role (`MANAGER_ROLES`: admin, owner, manager). Routes, `lib/edits.js` and `applyListingPatch` all call it; a test fails if a second `canEdit` appears.
* **SEC-04 (Non-Blocking Storage Purge):** Cloud file deletions (`deleteStorageFiles`) must execute outside the database transaction boundary so storage API latency never blocks the connection pool.
* **SEC-05 (Excel Sanitization):** Bulk Excel uploads are capped at 5MB, checked for valid magic bytes (`PK\x03\x04`), and cells starting with dangerous characters (`=`, `+`, `-`, `@`, `\t`, `\r`) are sanitized via `sanitizeCellValue` to neutralize formula injection attacks.


---

### 7. Layering & Release 1 Modules
Target layering: **`routes` → `lib/registry.js` → `services` (return data) → `domain` (pure)**. Release 1 moved the parts it touched; the rest of `routes/` still matches commands with its older regex chain, after the registry.

#### A. `domain/` (pure: no I/O, no WhatsApp, no database)
| Module | Responsibility |
| :--- | :--- |
| `describe.js` | **The one description template.** `brokerCard` (facts + internal lines), `reviewCard` (the only surface with field warnings and blockers), `savedCard`, `clientCopy` (ar/en; nothing internal; English has no Arabic script), `compactLine` + `featuresLine` (search result, "+N" after 4 features), `searchResults`, `planCopy` (one primary plan), `flyerModel` (data the flyer renders). Unknown fields are left out; nothing is invented. Shared pieces: `factLines` (client-safe facts), `internalLines` (owner, owner phone, commission, co-broker, notes), `paymentLines`, `priceLabel`, `money`, … |
| `fieldRules.js` | **The field table** (plan "Field rules"): `evaluate(listing, { lang, photoCount })` → `{ ok, blockers, warnings, listing, kind, case }`. `unitKind` (apartment/studio/villa/commercial/land), `paymentCase` (rent/primary/resale_installments/resale_cash), `normalizeForRules` (studio → 0 bedrooms, the third resale amount derived from the other two), `resaleMismatch` (> 100 EGP), `warningLine`/`blockerLine`. |
| `features.js` | The fixed bilingual feature dictionary (`FEATURES`: key, ar, en, group, synonyms). `classifyFeatures` splits free text into keys and `other`; `keysFromDetails` reads legacy boolean flags; `featureLabel`, `sortKeys`, `searchTermsFor`. The same list feeds descriptions, search filters and the search text. |
| `delivery.js` | `parseDelivery` (text or `{ year, quarter, month, ready }` → structured columns; "استلام فوري"/"ready" → `is_ready`), `formatDelivery` (`🗓 تسليم 2027 Q3` / `🔑 استلام فوري`), `hasDelivery`. |
| `places.js` | Bilingual compound, developer and area dictionaries (`COMPOUNDS`, `DEVELOPERS`, `AREAS`), `findPlaces`/`resolvePlace` → `{ kind, key }`, `placeName`, `synonymRows` (seed for `compound_synonyms`). |
| `searchText.js` | **The one normalizer** `normalizeSearch` and its SQL twin `NORMALIZE_SEARCH_SQL` (`public.normalize_search`), which must agree byte for byte (D2). |
| `searchQuery.js` | Request → **language-neutral filters**: `emptyFilters`, `normalizeAiSearch` (AI JSON, current and earlier shapes), `fallbackParse` (local regex parser), `canonical` (sorted, de-duplicated), `classifyIntent` (B2: only a request with a filter is a search), `hasAnyFilter`, `normalizeCode` (same folding as `code_norm`). |
| `vocabulary.js` | Property-type words (`TYPE_TERMS`) and `seedVocabulary(client)`, which writes `search_vocabulary` and `compound_synonyms` from the dictionaries. |

#### B. `services/search.js` (the one search service; returns data)
* `search({ pool, AI, agencyId, text, ctx })`: `parseRequest` (AI route `search_parse`, local parser on any failure) → intent guard → `runSearch`. Returns `{ status: results|none|small_talk|listing, parsed, source, rows, ids, total, relaxed, timings }`.
* `buildSearchQuery(agencyId, filters, { relaxed })`: agency-scoped, active-only SQL. Place keys use the indexed key columns, free place words the search document; features use `feature_keys @>`; delivery, payment (cash, installments, max down payment, max installment), finishing, furnishing and floor are columns. Order: `confirmed_at DESC, created_at DESC, id DESC` (stable). The relaxed pass widens price/area ±15% and bedrooms ±1 and drops bathrooms/floor/finishing/furnishing; the place stays locked.
* `runSearch` returns the first page and an **id snapshot** (up to `SNAPSHOT_MAX` = 100); `pageByIds` pages that snapshot (B1: no repeats or shifts when inventory changes; sold units are skipped).
* `lib/search.js` is the WhatsApp adapter: it formats with `Describe.searchResults` (plus the web "refine and see all" link), logs `search_query`, and keeps the snapshot in `broker_sessions` (`search_state`, 30 minutes) for "المزيد"/More (`handleMore`). Text and voice call the same function, so the same request returns the same ids in the same order (parity tests).

#### C. Edits, quick updates and the write path
* **`lib/listingStore.js`:** `findByCode(db, agencyId, code, { forUpdate })` (code or developer code through `code_norm`); **`createListing(db, broker, { fields, code, lang })`, the one insert path** (inside a transaction; insert-only, a stated code that exists returns `{ conflict, code }`, a generated one is regenerated under a savepoint; `confirmed_at` set); `addPhotos`/`removePhotos` (`listing_images`, agency-scoped; removed URLs are deleted from storage after commit); and **`applyListingPatch(db, broker, { listing, patch, expectedVersion })`, the one write path for edits and quick updates**: `canEdit` is checked, only `PATCH_COLUMNS` are written, `price_display` is recomputed with the price, and the update is `WHERE id AND agency_id AND version = expectedVersion`. A stale version returns `{ conflict: true }` (**optimistic locking**), never an overwrite. On success: `version + 1`, `confirmed_at = now()`, `flyer_cache = '{}'`.
* **`lib/edits.js`:**
  - `quickUpdate` (sold, archive, available, price) by text, voice or button: without a code it uses the unit the broker looked at last (`session_context.recent_code`, 1 hour). Runs under the `(agency, code)` advisory lock and a row lock; developer units refuse direct price edits (EDT-04).
  - Staged edits: `startEdit` (inline instructions are reviewed at once, A3) → `appendToEdit` (text and voice during an edit never become a search, A4) → `reviewEdit` (AI extraction or the local price parser when the AI is down → `composeFields` with the existing row → `fieldRules.evaluate` → `diffPatch`; the patch and the version seen are staged in `broker_sessions` `edit`, 30 minutes) → `confirmEdit` (applies with `expectedVersion`; a conflict asks for a new review) / `cancelEdit`.
* **`lib/registry.js`:** the command registry for the commands Release 1 touched: `price`, `status` (sold/archive/available), `edit`, `edit_done` (only while an edit is open), `more` (only while a search is open). Each entry is `{ name, match(text, state), run }` with anchored matchers, so the first match is the only match. A voice transcript may trigger only `price` and `status`. `routes/commands.js` and `routes/media.js` call `Registry.dispatch` before the legacy chain.
* **`lib/buttons.js`** (`BUTTONS`, `QUICK_ROWS`, `quickSections`, `cardButtons`): one id and one bilingual title per action. **`lib/copy.js`** (`COPY`, `t(key, lang, vars)`): one wording per Release 1 message.

#### D. Flyer worker
* One pipeline: `renderFlyerOnDemand` (button `flyer:…` and the `كتالوج CODE` command; the old `deliverFlyer` is gone, A7/V1). It reads the model from `Describe.flyerModel`, caches by a key that follows the data (`flyerCacheKey`), and sends **one** image with its caption.
* Rendering (satori + sharp) runs in a `worker_threads` worker (`lib/flyerWorker.js`) behind a limiter of one job (`FLYER_MAX_QUEUE` waiting, default 6, then `QUEUE_FULL`) with a timeout (`FLYER_TIMEOUT_MS`, default 45 s) that terminates a stuck worker. Under tests the worker is off (`FLYER_WORKER`), so rendering is inline.
* Sample PNGs (`npm run flyer:samples`, `tests/flyer/samples/`) are the reviewed regression snapshots; measured peak RSS with `MALLOC_ARENA_MAX=2` is about 250 MB, which fits Render Starter.

#### E. Onboarding & hosting
* **`lib/onboarding.js` + `scripts/onboard.js`** (`npm run onboard -- <agency.json> [--dry-run]`): validates the file (agency name, optional `slug`, `#RRGGBB` colours, `dark|light` theme, https logo; Egyptian mobiles; roles broker/agent/admin/owner/manager; at least one manager role), then in one transaction creates or updates the agency (matched by name) and its brokers (matched by phone). A phone registered with another agency (or a slug used by another agency, `SLUG_TAKEN`) is an error, never a silent move. It prints the agency slug and the web app address. Example: `docs/pilot/agency.example.json`; broker how-to: `docs/pilot/broker-howto-ar.md`.
* **`render.yaml`:** one Render web service (Starter, Frankfurt), `npm ci --omit=dev`, `npm start`, health check `/health`, `NODE_ENV=production`, Node 22, `MALLOC_ARENA_MAX=2`. Secrets (`PUBLIC_BASE_URL`, `DATABASE_URL`, WhatsApp, Gemini, Supabase) are set in the dashboard (`sync: false`). Move to Standard if measured peak memory stays above about 400 MB.

#### F. Web app (`web/`, Release 2)
* **Same app, same pool:** `server.js` calls `mountWeb(app, { pool, config })` after `/webhook` and `/health`. The broker web app lives under **`/app/`**; the root holds only `robots.txt` (`Disallow: /app/`) and, from step 7, the public unit pages. Next.js is reserved for future SEO sites.
* **Rendering:** server-side HTML from tagged templates (`web/html.js` `html```: every interpolated value is HTML-escaped unless it is `SafeHtml`), plus htmx 2 for partial updates. No template engine and no client framework. `layout()` renders Arabic RTL by default (`lang="ar" dir="rtl"`) and LTR for English, with logical CSS properties so one stylesheet serves both.
* **Page modules:** `web/routes/*.js` export `register(router, ctx)` and are listed in mount order in `web/routes/index.js` (`PAGES`); `ctx = { pool, config, assets, page }`.
* **Static files (`web/assets.js`):** read once at boot into memory (never written at runtime), content-hashed, served at `/app/static/<name>?v=<hash>` with an immutable cache (unversioned URLs are `no-cache`). htmx comes from the pinned `htmx.org` package.
* **PWA:** `/app/manifest.webmanifest` (scope and start URL `/app/`) and `/app/sw.js`, generated from `web/static/sw.js` with the asset version and list, sent with `Service-Worker-Allowed: /app/` and `no-cache`. The worker precaches the static files and `/app/offline`, serves static files cache-first and pages network-only with the offline fallback, and ignores non-GET requests and everything outside `/app/`, so private pages are never cached.
* **Security headers (`web/security.js`):** CSP `default-src 'self'; script-src 'self'; style-src 'self'` (no inline script or style; htmx runs with `allowEval: false`), `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: same-origin`, `Permissions-Policy` (microphone for the voice button only). `sameOrigin()` refuses POSTs that the browser marks cross-site (`Sec-Fetch-Site`) or whose `Origin` is not the site origin (`Links.siteOrigin()`), in addition to the CSRF tokens of step 3.
* **Sign-in (magic link, `lib/webAuth.js`, `web/routes/auth.js`, `web/session.js`):**
  - **Getting a link:** the broker sends **«دخول»/login** to the bot (registry command `web_login`), or enters the registered mobile on `/app/login`, which sends the link on WhatsApp through `dispatcher.notify` (the answer is the same for unknown numbers, so the form reveals nothing). The link is `Links.loginLinkUrl(token)`: `/app/login/confirm?t=<token>`.
  - **GET → POST:** the GET confirm page uses nothing (WhatsApp link previews and scanners may open it); its button POSTs the token. Only the POST consumes it (`UPDATE … SET used_at … WHERE used_at IS NULL AND expires_at > now()`, atomic), so a token works once. The confirm pages send `Referrer-Policy: no-referrer`.
  - **Hashed tokens:** login tokens (32 random bytes, base64url) and session ids are stored only as SHA-256 hashes; the plain value exists only in the link or the cookie.
  - **Sessions:** 30 days from sign-in (`SESSION_DAYS`), cookie `__Host-aq_sid` on https (`aq_sid` on http dev): `HttpOnly`, `SameSite=Lax`, `Secure`, `Path=/`. A new session id on every sign-in; sign-out revokes it; a deactivated broker's sessions stop at once (`getSession` joins `brokers.is_active`). `revokeAllSessions(brokerId)` signs a broker out everywhere.
  - **CSRF:** every non-GET request of a signed-in broker must carry the session's `csrf_token` (`X-CSRF-Token` header, set for htmx by `app.js` from `<meta name="csrf-token">`, or a `_csrf` form field), compared in constant time. Sign-in forms, which have no session yet, use a double-submit token (`__Host-aq_pre` cookie echoed in `_csrf`). Plus the same-origin check above.
  - **Gate:** `web/routes/index.js` splits pages into `PUBLIC` (sign-in) and `PRIVATE`; private pages get `Cache-Control: no-store`, `requireBroker` (303 to `/app/login?next=…`, htmx gets `HX-Redirect`, others 401) and `verifyCsrf`. `safeNext` only follows same-site `/app/` paths.
  - **Rate limits (`lib/rateLimit.js`, `LIMITS`):** Postgres fixed windows (`web_rate_limits`), so every pod shares them. Link requests: 20/hour per IP and 5/hour per number on the web, 6/hour per broker on WhatsApp; confirms: 30/10 min per IP. Over the limit: 429 with `Retry-After` (WhatsApp: "طلبت روابط دخول كتير"). In production `trust proxy` is on so `req.ip` is the client behind Render's proxy.
  - **Telemetry:** `operation_logs` rows `web_login_link` (status success|dropped) and `web_login`; the WhatsApp message is counted as `wa_outbound` with `kind = web_login_link`.
  - **24-hour window:** a link asked for on the web is a free-form WhatsApp message, so Meta delivers it only inside the broker's 24-hour window; the page tells the broker to send «دخول» to the bot otherwise.
* **Web search (`web/routes/search.js`):** the same `services/search.js` as WhatsApp, so the same request gives the same ids in the same order.
  - `GET /app/search?q=` runs `Search.parseRequest` (AI, local parser on failure) and the intent guard; `?f=<token>` and the refine form skip the AI. Results come from `runSearch` (strict, then relaxed) and pages of 20 (`WEB_PAGE_SIZE`) from its id snapshot (`pageByIds`), up to `SNAPSHOT_MAX` = 100. Each result is `Describe.compactLine` with **every** feature as a tag (WhatsApp cuts after 4 with "+N").
  - **Filters in a URL (`domain/searchLink.js`):** `encodeFilters` → base64url JSON of the set canonical fields; `decodeFilters` never trusts the content (`sanitizeFilters`: unknown keys dropped, types checked, places and features must exist in the dictionaries) and the agency always comes from the session. `filtersFromForm` sends form fields through `normalizeAiSearch`, so a place typed in either language resolves to the same key; `formFromFilters` prefills the form.
  - **"Refine and see all" from WhatsApp:** every WhatsApp search reply (results or none) ends with `🌐 عدّل البحث وشوف كل النتائج: <Links.searchUrl(token)>`, in the same message.
  - **Saved searches:** save (name + token; at most 50 per broker), list with the number of units not seen since the last run (`seen_ids`), open (runs it and resets `seen_ids`), delete. Per broker and agency-scoped.
  - Free-text searches are limited to 60 a minute per broker (AI cost); each search writes `operation_logs` `search_query` with `metadata.channel = 'web'`.
* **Units (`web/routes/units.js`):** `/app/units` (agency list, status tabs, "mine only") and `/app/units/<code>` (every fact and the internal lines through `Describe.factLines`/`internalLines`, photos), agency-scoped through `findByCode` and `Authz.canView`. Fragments live in `web/views/`.
* **Add/edit form (`web/routes/unitForm.js`, `web/forms/unitForm.js`, `web/views/unitForm.js`):** the web twin of the WhatsApp draft and edit, on the same modules.
  - **The form is the full desired state** (`unitFromForm` → `composeFromForm`): `composeFields` with the existing row keeps what the form does not own (title, search keywords, curated images, other details), then every form-owned column and detail is set exactly as submitted, so a cleared field becomes NULL and an unticked feature is removed. Prices accept "8.5 مليون", "9,500,000" and Arabic digits (`lib/text.js` `parseEgyptianPrice`).
  - **Field rules:** `domain/fieldRules.evaluate` decides. "📋 مراجعة" (htmx) returns the review panel, the only web surface with field warnings; Save refuses while a blocker is open (422) and shows the panel.
  - **Fill from text or voice:** "✨ املأ من الوصف" and the 🎙️ voice button (`web/static/voice.js`: MediaRecorder, `audio/ogg` or `audio/webm;codecs=opus` or `audio/mp4`, posted with the form) call `L.extractPropertyDetails` through the AI gateway (quota, telemetry `listing_extraction`; 20 per 10 minutes per broker), and merge the result into what the form already says (`composeFields`). The AI down or the quota spent: the broker is told and keeps the form.
  - **Create:** `listingStore.createListing` (insert-only; a used code in any case → 409 "الكود مستخدم", nothing written, uploaded photos removed). **Edit:** under the `(agency, code)` advisory lock and a row lock, `canEdit`, the field table, `Edits.diffPatch`, then `applyListingPatch` with the **version the form was opened at** (hidden field): a change made meanwhile (WhatsApp or another tab) is a 409 conflict, never an overwrite. Telemetry: `web_unit_create`, `web_unit_edit` (columns), `web_unit_extract`.
  - **Photos:** up to 15 per unit; each upload is normalized in memory by `lib/images.js` `normalizeImageBuffer` (the same as WhatsApp: EXIF rotate, 1600 px, JPEG Q82) and stored before the transaction; removal and addition happen in the same save; storage deletes run after commit (SEC-04).
* **Body parsing and uploads:** `/app` adds `urlencoded` forms (limit `BODY_LIMIT`). Multipart bodies are parsed only by `web/uploads.js` (`multer` memory storage, never disk; 10 MB a file; type allowlists, 415 otherwise). Because the CSRF check runs before parsing, a multipart request without the `X-CSRF-Token` header may defer to the `_csrf` form field **only on routes registered with `Session.allowMultipart`**; `uploads()` checks it right after parsing. Anywhere else a multipart POST without the header is refused.

---

### 8. Testing, CI & Change Discipline
* **Every change ships with tests and doc updates.** A change is complete only when it includes tests that cover it and updates to this manifest, `FEATURE_REGISTRY.md` and `API_CONTRACTS.json` where they are affected. (Release 1 ran under a POC exception; its docs were caught up at the start of Release 2.)
* **`API_CONTRACTS.json` is generated from the real exports:** `node scripts/api-contracts.js` rewrites the `libraries` map (export name → parameter names, or a type name). `tests/contract-guard.test.js` fails when a listed module's exports or parameters differ from the file, or when a module in `lib/`, `domain/` or `services/` is missing from it.
* **`SCHEMA_REFERENCE.sql` is regenerated with every migration** (`npm run schema:reference`; §2).
* **Behaviour tests drive the real router.**
  - `tests/web/*.test.js` drive the web app with `supertest` against the same `createApp` (PGlite and the same fakes).
  - `tests/router/*.test.js` send real webhook payloads through `createApp(...).handleWebhookBody` and assert on the outbound WhatsApp messages and the resulting DB rows.
  - The external edges are replaced by recording fakes in `tests/harness/`:
    - `fake-whatsapp.js` records outbound messages and serves inbound media.
    - `fake-ai.js` returns scripted Gemini answers.
    - `fake-supabase.js` is an in-memory storage bucket.
* **Real Postgres in-process:**
  - `tests/harness/db.js` loads `db/schema.sql` into PGlite (Postgres compiled to WASM, with `pg_trgm`, `pgcrypto` and `uuid-ossp`) behind a `pg.Pool`-compatible adapter. No Docker or external database is needed.
  - NUMERIC and INT8 come back as strings, exactly like node-pg.
  - There is one database per test file, reset with `TRUNCATE` between tests.
* **Known defects are executable.** Confirmed bugs are written as `test.failing(...)`, named with their remediation-plan ID (e.g. `A1`, `F2`, `D1`). The fixing change converts the test to a normal `test(...)`. After Release 1 no `test.failing` remains; the IDs live on in the test names (FEATURE_REGISTRY §11).
* **Commands:**
  - `npm run test:ci` runs all offline tests: `node --test` e2e plus every Jest suite.
  - `npm run test:router` runs only the router behaviour tests.
  - `npm test` adds the live-schema audit and the live search pipeline, which need `.env`.
* **CI:** `.github/workflows/test.yml` runs `npm run test:ci` on Node 22 for every push and pull request. Don't merge to `main` with a red build.