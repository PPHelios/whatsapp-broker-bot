# ARCHITECTURE_MANIFEST.md
## Canonical System Architecture & Operational Invariants

### 1. Platform Infrastructure & Render Hosting Constraints
* **Ephemeral Filesystem:** Render web service instances run on ephemeral disks. Local disk writes to `/tmp` or project subdirectories are strictly prohibited.
  - Image normalization via Sharp must accept an in-memory `Buffer` and return a compressed `Buffer` directly to Supabase Storage.
  - Excel ingestion and rejection workbooks must be handled entirely in-memory using Node.js streaming buffers (`stream.PassThrough` or `Buffer.from`).
  - System fonts (`Cairo-Bold.ttf`, `Cairo-Regular.ttf`) must be pre-warmed into process memory on server boot via `Flyer.loadFont(...)`.
* **App Factory & Bootstrap:** `server.js` exports `createApp({ pool })`, which builds the Express app and the message pipeline around an injected pg-compatible pool. It returns `{ app, state, handleWebhookBody, dispatchMessage, bootRecovery, preWarmAssets }`. Only `start()` creates the real `pg.Pool`, binds the port and installs signal handlers, and it runs only when `server.js` is executed directly (`require.main === module`).
* **Non-Blocking Port Binding:** The HTTP server (`app.listen`) must bind immediately to `process.env.PORT` to satisfy Render health probes within the platform's timeout window. Heavy initialization tasks (font loading, recovery routines) must run asynchronously in the background.
* **Graceful Termination & Drain Protocol:** On `SIGTERM` or `SIGINT`, the service enters a draining state:
  - Halts acceptance of new incoming webhooks (returns HTTP 503 so Meta Graph retries).
  - Permits up to 25 seconds for in-flight tasks (`inFlight > 0` and per-broker queues) to finish executing and write logs before closing the `pg.Pool`.
* **Zero-Downtime Multi-Pod Concurrency:** Because Render runs concurrent containers during blue/green deploys, all unit mutations (edits, deletions, status transitions) must acquire distributed PostgreSQL transactional advisory locks:
  `SELECT pg_advisory_xact_lock(('x' || substr(md5($1 || ':' || $2), 1, 16))::bit(64)::bigint)` using `[String(agency_id), String(code).toUpperCase()]`.

---

### 2. Verified Database Schema & Data Contracts
The database runs on PostgreSQL (Supabase) with the `pg_trgm`, `pgcrypto` and `uuid-ossp` extensions.

**Source of truth:** `db/schema.sql` is the canonical schema: extensions, sequences, functions, tables (including generated columns), constraints, indexes and triggers. It is generated from the live catalog by `npm run schema:export` (`scripts/export-schema.js`, which runs in a READ ONLY transaction) and must not be edited by hand. Regenerate it and commit it whenever the database changes. The test database is built from this file. `SCHEMA_REFERENCE.sql` is the older table-only reference and is superseded.

#### A. Core Tables & Identity
* **`agencies`**: Stores multi-tenant agencies (`id`, `name`, `logo_url`, `primary_color`, `secondary_color`, `flyer_theme`, `phone`).
* **`brokers`**: Identity and WhatsApp phone mapping.
  - *Invariant:* Always reference `brokers.phone_number` and `brokers.phone_normalized`. Lookups must match against `phone_normalized`.
  - Columns: `id`, `agency_id`, `name`, `phone_number`, `phone_normalized`, `contact_phone`, `role`, `is_active`, `preferred_lang`, `last_active_at`.
* **`projects`**: Master developer portfolios (`id`, `agency_id`, `name`, `developer_name`, `location`, `district`, `city`, `collateral`, `media`).

#### B. Inventory & Media
* **`listings`**: The core inventory store.
  - Columns: `id`, `agency_id`, `broker_id`, `project_id`, `code`, `title`, `property_type`, `listing_type`, `price_value`, `price_display`, `area_value`, `bedrooms`, `location`, `compound`, `district`, `city`, `location_keywords`, `status`, `is_primary_developer`, `inventory_type`, `developer_unit_code`, `down_payment_value`, `installment_years`, `installment_value`, `payment_frequency`, `delivery_date`, `maintenance_pct`, `bathrooms`, `compound_en`, `search_text_normalized`, `details`, `payment_terms`, `collateral`, `flyer_cache`.
  - *Details JSONB Contract:* Stores auxiliary attributes (`finishing`, `finishing_en`, `floor`, `nanny_room`, `driver_room`, `has_master_bedroom`, `has_dressing_room`, `ready_to_move`, `bua`, `land_area`, `roof_area`, `garden_area`, `villa_type`, `image_order`, `description_ar`, `summary_ar`, `total_upfront_cash`, `remaining_debt`, `over_price`).
  - *Missing Attribute Rule:* Missing fields must be stored as explicit SQL `NULL`. Default values (e.g., assuming "Fully Finished" or "2029") are forbidden.
  - *Mutation Cascade Rule:* Editing price, area, finishing, or bedrooms must trigger:
    1. Re-synthesis of Arabic (`title`) and English (`title_en`) titles.
    2. Re-indexing of `search_text_normalized` via `clean_arabic_text(...)`.
    3. Purging of `flyer_cache = '{}'::jsonb`.
    4. Curated photo orders and roles in `listing_images` must be preserved.
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
#### D. Domain Responsibility Partitioning (State & Ingress)
* **`lib/drafts.js` Contract:**
  - Manages session lifecycle inside `public.broker_sessions` (composite key `[broker_id, session_type]`).
  - Implements the complete ingestion commit pipeline (`commitDraftToDatabase`) under a 64-bit transactional advisory lock.
  - Persists uncurated images to `listing_images` (`role = NULL`), deferring Gemini Vision curation to the first luxury flyer render.
* **`lib/listing.js` (Pure Extraction & Parsing):**
  - Pure calculation and transformation helpers: `composeFields`, `generateListingCode`, `validateDraft`, `checkDraftCompleteness`, and Gemini prompt assembly.
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
  - Handlers send only through `lib/dispatcher.js`: `reply`, `replyButtons`, `replyList`, `replyImage`, `replyDocument` and `react`. They never call `WA.send*` directly; a test in `tests/unit/whatsapp-client.test.js` enforces this.
  - A turn counts as answered **only after WhatsApp accepts the message**, i.e. a non-null result. A failed or dropped send leaves the turn unanswered, so `executeGuardedTurn`'s safety net still replies.
  - A delivered 📸 reaction answers a photo turn.
  - The single exception is the unregistered-number notice in `server.js`, which runs outside any broker turn.
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
* **SEC-04 (Non-Blocking Storage Purge):** Cloud file deletions (`deleteStorageFiles`) must execute outside the database transaction boundary so storage API latency never blocks the connection pool.
* **SEC-05 (Excel Sanitization):** Bulk Excel uploads are capped at 5MB, checked for valid magic bytes (`PK\x03\x04`), and cells starting with dangerous characters (`=`, `+`, `-`, `@`, `\t`, `\r`) are sanitized via `sanitizeCellValue` to neutralize formula injection attacks.

---

### 7. Testing, CI & Change Discipline
* **Every change ships with tests and doc updates.** A change is complete only when it includes tests that cover it and updates to this manifest, `FEATURE_REGISTRY.md` and `API_CONTRACTS.json` where they are affected.
* **Behaviour tests drive the real router.**
  - `tests/router/*.test.js` send real webhook payloads through `createApp(...).handleWebhookBody` and assert on the outbound WhatsApp messages and the resulting DB rows.
  - The external edges are replaced by recording fakes in `tests/harness/`:
    - `fake-whatsapp.js` records outbound messages and serves inbound media.
    - `fake-ai.js` returns scripted Gemini answers.
    - `fake-supabase.js` is an in-memory storage bucket.
* **Real Postgres in-process:**
  - `tests/harness/db.js` loads `db/schema.sql` into PGlite (Postgres compiled to WASM, with `pg_trgm`, `pgcrypto` and `uuid-ossp`) behind a `pg.Pool`-compatible adapter. No Docker or external database is needed.
  - NUMERIC and INT8 come back as strings, exactly like node-pg.
  - There is one database per test file, reset with `TRUNCATE` between tests.
* **Known defects are executable.** Confirmed bugs are written as `test.failing(...)`, named with their remediation-plan ID (e.g. `A1`, `F2`, `D1`). The fixing change converts the test to a normal `test(...)`.
* **Commands:**
  - `npm run test:ci` runs all offline tests: `node --test` e2e plus every Jest suite.
  - `npm run test:router` runs only the router behaviour tests.
  - `npm test` adds the live-schema audit and the live search pipeline, which need `.env`.
* **CI:** `.github/workflows/test.yml` runs `npm run test:ci` on Node 22 for every push and pull request. Don't merge to `main` with a red build.