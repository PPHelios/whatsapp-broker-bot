# AqarChat POC: Release 3 (Core CRM) build plan

## Context
Release 1 (WhatsApp-only slice) and Release 2 (the website, `/app/` plus the public unit pages) are merged to `main` and running on Render. The pilot is still one design-partner agency with 3–5 brokers.

Release 3 is the **Core CRM** from `docs/plans/poc-release-1.md` "Later releases → Release 3" (about 3–5 days):
- `leads` and `lead_events`
- Intake from forwarded text, voice or CSV, with dedupe
- Assign with a `[Call][WhatsApp]` card
- Stages and follow-ups
- Buyer requests (`saved_searches.lead_id`) with match alerts
- Deals and commission
- The **PDPL items for leads** from the Release 1 review (Law 151/2020): lawful basis or consent, retention, deletion and export on request, access limited by role, no lead data on public pages.

Leads are the first **personal data about people who are not our users** (the agency's clients). That changes the security bar. Listings hold an owner name and phone too, but leads are the whole point of the table: names, phones, budgets, and what a person wants to buy.

**Working mode (same as Release 2):**
- Claude writes all the code.
- **Full tests** ship with every change: router tests on the real webhook (`createApp(...).handleWebhookBody`), supertest web tests on the same `createApp`, and unit tests for every `domain/` module. All of them run on the PGlite harness (`tests/harness/`) and the fakes, with no external services.
- **Docs are updated every step** (the standing rule, ARCHITECTURE_MANIFEST §8). There is no POC exception this time. Each step updates `ARCHITECTURE_MANIFEST.md`, `FEATURE_REGISTRY.md` (new `CRM-*` features, coverage map rows, defect IDs), `API_CONTRACTS.json` (`node scripts/api-contracts.js`), `SCHEMA_REFERENCE.sql` (`npm run schema:reference` in every migration commit) and `docs/runbook.md` where they're affected.
- `tests/contract-guard.test.js` and `tests/unit/docs.test.js` stay green at every commit. Every new env var goes into the runbook table, and every migration is named in the manifest.
- After each step: `npm run test:ci`, commit, push `poc/release-3`, and send a short progress note. No PR review. Merge to `main` when every step is green (the same merge policy as Release 1 §Handoff 5).
- The test `DATABASE_URL` in the cloud environment holds no production data. Even so, **never clear `operation_logs`**.

## Locked decisions (carried over, not reopened)
- Layering is **`routes` → `lib/registry.js` → `services` (return data) → `domain` (pure)**. All new CRM code follows it from the start. No CRM command goes into the legacy regex chain.
- One outbound path: messages are sent through `lib/dispatcher.js` (`reply*` inside a turn, `notify` outside one). They're counted in `wa_outbound` with a `kind`.
- One search service: buyer requests are canonical filters (`domain/searchQuery.js`) that are run by `services/search.js` `buildSearchQuery`. Match alerts don't add a second matcher.
- One description template: units in lead cards, matches and deals come from `domain/describe.js` (`compactLine`, `featuresLine`, `clientCopy`). Lead cards get their own pure module, but they reuse its `money`/`priceLabel`.
- Buttons come from `lib/buttons.js`, copy from `lib/copy.js`, rights from `lib/authz.js` (still the single copy), and limits from `lib/rateLimit.js` `LIMITS`.
- Web: Express + htmx under `/app/`, server-rendered with `web/html.js`, CSRF, `no-store` on private pages, and a service worker that never caches pages. Every link is built by `lib/links.js`.
- Tenant isolation (SEC-02): every lead, event, request, match and deal query is `agency_id = $1`. The tenant contract test is extended to cover them.
- Every mutation runs in a transaction. Multi-pod safety: lead writes take a row lock (`FOR UPDATE`) and use optimistic locking (`version`), like `applyListingPatch`.

## Open questions (owner decides; recommended default in bold)
Every item below has a default. If you answer "defaults", the build starts with all of them. Items marked ⚖️ touch PDPL, so a quick check with the agency's lawyer is worth it before the pilot uses real client data.

**Q1 ⚖️ Who may see which leads?**
- **Default:** a broker sees the leads assigned to them. Managers (`admin`, `owner`, `manager`) see every lead in the agency. Unassigned leads are visible to managers only.
- A lead created by a broker is assigned to that broker.
- When a lead is reassigned, the previous broker loses access to it. Their own events stay in the timeline, under their name.
- *Alternative:* the whole agency sees every lead, as with listings. This is not recommended, because PDPL asks for need-to-know access.

**Q2 Duplicate lead owned by a colleague** (the same phone is captured by a second broker):
- **Default:** the first broker keeps the lead. The new inquiry is added to the lead as an event, and the owner gets one message about it ("نفس العميل سأل تاني عن طريق <name>").
- The second broker is told "العميل ده متسجل مع زميل، اتبعتله إشعار". They see the colleague's name, but no lead details.
- Managers can reassign it.

**Q3 Assignment of imported or unassigned leads:**
- **Default:** a CSV imported by a manager uses its `assigned broker` column (by phone or name) when present, and leaves the other rows unassigned. The preview offers "round-robin among active brokers" as a tick box.
- Leads that brokers capture themselves are always self-assigned.
- *Alternative:* round-robin automatically.

**Q4 Lead stages.**
- **Default** (7 stages, in order):
  1. جديد (new)
  2. تم التواصل (contacted)
  3. مهتم (qualified)
  4. معاينة (viewing)
  5. تفاوض (negotiation)
  6. اتقفل ✅ (won)
  7. خسرناه ❌ (lost)
- Lost needs a reason, chosen from: السعر, اشترى من مكان تاني, مش جاد, مش بيرد, تاني.
- Any stage can move to any other, and every move is a `lead_events` row.
- Won is set when a deal is recorded, or by hand.

**Q5 Follow-up reminders: timing and channel.**
- **Default:** one open follow-up per lead, with a date and an optional time. A date alone means **10:00 Cairo time**.
- The reminder goes to the assigned broker on **WhatsApp** at that time. Brokers with several due at once get **one message** listing up to 5 (with the rest counted), not one message per lead.
- The quick choices are بكرة / بعد 3 أيام / الأسبوع الجاي, or a typed date.
- A new lead that has gone **24 hours** with no contact event gets one nudge.
- No reminders go out from 22:00 to 08:00 Cairo time; those are held until 08:00.
- **Channel caveat:** a free-form WhatsApp message only reaches a broker inside their 24-hour window. Outside it, the reminder is marked `undelivered`, and it stays on the web "متابعات النهارده" list. Release 4 sends it with a template (see "Meta templates" below).

**Q6 Match alerts for buyer requests.**
- **Default:** when a unit becomes a match for a lead's request (newly added, made available again, or price-dropped into the range), the assigned broker gets an alert **within about 1 minute**, grouped as one message per broker per sweep. Each unit is alerted **once per request**.
- Only strict matches alert. The relaxed ±15% pass is shown on the web lead page, but it doesn't alert.
- A broker gets at most **10 match alerts a day**; the rest wait on the web page.
- The client is **never** messaged automatically. The broker taps "ابعت للعميل" and sends the message themselves.

**Q7 ⚖️ Lawful basis and consent.**
- **Default:** every lead stores a `lawful_basis`:
  - `client_request`: the client contacted the agency or asked to be contacted. This is the default for forwarded text, voice and contact cards.
  - `consent`: explicit consent, recorded with a date and a note.
  - `existing_client`.
- **CSV imports** need the uploader to tick a confirmation: "العملاء دول طلبوا التواصل أو وافقوا عليه".
- The agency's own **privacy note** (one Arabic paragraph) is shown on the import page and in the export file. The agency supplies the text; a placeholder ships until then.

**Q8 ⚖️ Retention period.**
- **Default:** a lead with **no activity for 18 months** is **erased automatically**. Activity means any event, follow-up or deal. Managers see "هيتمسح خلال 30 يوم" on the lead first.
- Deals are kept for accounting, but the client's name and phone are stripped when their lead is erased.
- `inbound_messages.payload` (which holds forwarded client texts and contact cards) is cleared **7 days** after the message completes.
- Pending CRM sessions expire in 30 minutes.
- Durations are config (`LEAD_RETENTION_MONTHS`, `INBOUND_PAYLOAD_DAYS`).

**Q9 ⚖️ Deletion and export on request.**
- **Default:** managers only, from the lead page.
  - **Export** downloads one file (`.json` plus a readable `.txt`, zipped) with the lead, its requests, events and deals. Other parties (co-brokers, colleagues' phones) are left out.
  - **Erase** is a hard delete of the lead, its events, requests and matches. The deals stay, with the client fields cleared.
- An `lead_erasures` row keeps only a **keyed hash of the phone**, the date and who erased it. That way a later intake of the same phone warns "العميل ده طلب مسح بياناته".
- *Alternative:* keep no hash at all. Then a re-import silently re-creates the person.

**Q10 Commission rules.**
- **Default:** commission is entered **per deal** as a percentage of the price, or as a fixed amount. Agency defaults (in `agencies.crm_settings`) prefill it:
  - Resale: **2.5%** (one side)
  - Rent: **one month's rent**
  - Primary: **entered per deal**, because the rate depends on the developer
- **Split:** a list of internal brokers with shares that must sum to 100% of the broker pool. The broker pool is the agency's commission × `broker_share_pct`, **default 40%**. An optional external co-broker share comes off the top first.
- Amounts are rounded to whole EGP, and the remainder goes to the closing broker.
- Statuses: pending → signed → paid, or cancelled.
- **Visibility:** a broker sees deals they're in and their own share. Managers see everything, plus the monthly totals.

**Q11 CSV/Excel columns.**
- **Default:** the accepted headers, in Arabic or English, in any order:
  - name
  - phone (required)
  - second phone
  - source
  - budget (max price)
  - area or compound
  - type
  - bedrooms
  - sale/rent
  - notes
  - stage
  - assigned broker
  - lawful basis
- Formats: `.csv` (UTF-8 with or without BOM, comma or semicolon) and `.xlsx`. Limits: 5 MB and **2,000 rows**.
- A template is offered at `/app/leads/import/template.xlsx`.
- Unknown columns are ignored and listed in the preview.

**Q12 Lead sources list.**
- **Default:** واتساب, فيسبوك, أوليكس/دوبيزل, بروبرتي فايندر, ترشيح, زيارة المكتب, مكالمة, تاني.
- The source is free text when nothing matches.

**Q13 WhatsApp words for the new commands.**
- **Default:** «ليد» / «عميل جديد» / «lead» to add a lead, «عملائي» / «leads» for my list, «متابعات» / «followups» for today's follow-ups, and «طلب» to add a buyer request to the open lead.
- `عميل CODE` (client copy) is unchanged. The matchers are anchored, so «عميل جديد» never reaches it, and a test pins this.

**Q14 The `[Call][WhatsApp]` card on WhatsApp.**
- A WhatsApp reply button can't open a phone dialer or a link. A `cta_url` message carries one link button only.
- **Default:** one message. The body holds the client's phone as a tappable `+20…` number (Call) and a `wa.me/<e164>` link with the broker's greeting prefilled (WhatsApp). The three reply buttons log what happened: **[📞 كلمته] [📅 متابعة] [🔄 المرحلة]**.
- The web lead page has real `tel:` and `wa.me` buttons.

## Lead field rules (the CRM twin of the listing field table)
| Field | Rule |
| --- | --- |
| Phone | **Mandatory.** It's normalized to E.164 (Egypt: `01x…` / `+20` / `0020` / Arabic digits → `201x…`). A non-Egyptian `+` number is kept as is. It's the dedupe key, unique per agency. |
| Name | Optional. Unknown shows "عميل بدون اسم". It's never invented from the phone or the chat. |
| Source, lawful basis | Set by the intake channel and never asked for. CSV takes them from the columns, or from the confirmation. |
| Request (budget, place, type, rooms, sale/rent, payment) | Optional. Stored as canonical search filters on a `saved_searches` row with `lead_id`. Unknown filters stay unset. |
| Stage | `new` on create. |
| Notes | Internal. They never reach a client, a public page or a client copy. |

Captured but unknown fields are left out of the lead card, just as in `describe`. Nothing is invented.

## Review findings (before building)
- **Architecture:**
  - **There's no scheduler.** Follow-up reminders, match alerts and retention all need a periodic job. Plan: `lib/scheduler.js` runs one `setInterval` tick (60 s) in each pod, guarded by `pg_try_advisory_lock`, so only one pod works on each tick. It's off under tests. Tests call `tick({ now })` directly, with an injected clock.
  - **Match detection can't hook every write path.** Units are written by draft commit, web create, edit, imports, bulk edit and quick updates, and `createListing` runs inside the caller's transaction. Plan: the scheduler scans listings changed since a stored watermark (`crm_jobs` row: `updated_at, id`). That catches every path without touching them, and it never alerts on a rolled-back write.
  - **Two phone normalizers** (`lib/util.js` `normalizePhone`, `lib/onboarding.js` `normalizeEgyptMobile`). Leads add a third use, and dedupe depends on them agreeing. Plan: one `domain/phone.js`, which both callers delegate to, with the cases pinned by unit tests (defect ID **P1**).
  - `web_imports.kind` allows `excel|group` only. Lead CSV import reuses the same plan → preview → apply-once flow, so the migration widens the CHECK constraint to add `leads`.
- **Data:**
  - Leads, events, requests, matches and deals all get `agency_id` NOT NULL, plus composite foreign keys or checks so that a row can't point across agencies (for example, a deal's `listing_id` must be in the same agency).
  - `lead_events` is append-only. The app never updates or deletes rows, except through erasure.
- **PDPL / security:**
  - **`inbound_messages.payload` keeps every forwarded client text and contact card forever** (finding **P2**). Plan: the scheduler clears the payloads of completed and failed rows older than `INBOUND_PAYLOAD_DAYS` (7). Crash recovery only needs recent rows.
  - **Logs and telemetry must never carry lead personal data.** `operation_logs.metadata` takes `lead_id` and counts only, never names, phones or texts. The logger already masks phones; a test greps the CRM telemetry rows for the sentinel phone and name (finding **P3**).
  - **Public pages must never show lead data.** The allowlist serializer (`domain/publicUnit.js`) doesn't change. A share link made for a lead carries `share_links.lead_id`, so the opened alert can say "أحمد فتح الرابط" to the broker, but the public page never reads it. A sentinel test covers this.
  - The match alert, follow-up and assignment messages go to brokers only, and they include only the lead's first name and request summary, not the phone. The phone appears only on the assignment card, sent to the assigned broker.
  - The lead export file is built server-side and served with `no-store` and `Content-Disposition: attachment`. It's never cached by the service worker, which already skips non-static paths.
- **Cost:**
  - Every CRM task answers in **one message**.
  - Reminders and match alerts are **grouped per broker per sweep**.
  - Most intake needs no AI call: a contact card and CSV need none, and a phone found by regex in a forward is enough for a lead. AI is used only to read a name and a request out of free text or voice.
- **UX:**
  - The lead card, timeline and match lines come from one pure module (`domain/leadCard.js`), so WhatsApp and the web show the same facts in the same order.
  - Stage names and emojis come from `domain/leadStages.js` only.

## Release 3 steps (build after approval)

### 0. Branch and plan
This plan, committed alone on `poc/release-3`. Nothing else.

### 1. Foundation: phone, scheduler, CRM settings
- `domain/phone.js`: `normalizePhone(raw, { defaultCountry: "20" })` → E.164 digits, or null; `isEgyptMobile`; `displayPhone` (`+20 10 1234 5678`); `waMeUrl(e164, text)`.
  - `lib/util.js` `normalizePhone` and `lib/onboarding.js` `normalizeEgyptMobile` delegate to it (**P1**). Broker lookups keep working, because `brokers.phone_normalized` already holds the same form; a test checks every seeded broker still matches.
- `lib/scheduler.js`:
  - `start({ pool, config })` / `stop()` / `tick({ pool, now })`. Each job in `JOBS` runs under its own `pg_try_advisory_lock`, so a slow job never blocks another and two pods never run the same one.
  - Every job writes one `operation_logs` row (`crm_job_<name>`, counts only).
  - `server.js` `start()` starts it after the port binds, and the drain stops it first.
  - Config: `SCHEDULER_ENABLED` (default on in production, off under tests) and `SCHEDULER_TICK_MS` (60000).
- **Migration `010_crm_settings.sql`:**
  - `agencies.crm_settings jsonb NOT NULL DEFAULT '{}'`: commission defaults, the privacy note text, quiet hours.
  - `crm_jobs` (`name` PK, `watermark jsonb`, `last_run_at`).
- **Tests:**
  - Unit tests for `domain/phone.js`: 20+ cases (Arabic digits, `+20`, `0020`, `01x`, spaces and dashes, landlines, foreign numbers, junk).
  - Scheduler: two concurrent ticks run each job once; a throwing job doesn't stop the others; the tick is off under tests.
  - `docs.test.js` (new env vars); `foundation` (broker lookup unchanged).

### 2. Leads data model and service
- **Migration `011_leads.sql`:**
  - `leads`:
    - `id`, `agency_id`, `ref` (a per-agency number shown as `L-0042`, set by a trigger; unique `(agency_id, ref)`), `assigned_broker_id` (SET NULL), `created_by_broker_id` (SET NULL)
    - `name`, `phone_e164` NOT NULL, `phone_alt`, `lang`
    - `source`, `source_detail`, `lawful_basis` CHECK (`client_request|consent|existing_client`), `consent_at`, `consent_note`
    - `stage` CHECK (the Q4 keys), `lost_reason`, `notes`
    - `next_follow_up_at`, `follow_up_note`, `follow_up_status` (`open|reminded|undelivered|done`)
    - `last_contact_at`, `last_activity_at`, `created_at`, `updated_at`, `version`
    - Unique `(agency_id, phone_e164)`. Indexes on `(agency_id, assigned_broker_id, stage)`, `(next_follow_up_at) WHERE follow_up_status IN ('open')` and `(agency_id, last_activity_at)`.
  - `lead_events` (`id`, `agency_id`, `lead_id` ON DELETE CASCADE, `broker_id`, `kind` CHECK (`created|inquiry|assigned|stage|note|contacted|follow_up_set|follow_up_done|request_set|match_sent|share_opened|deal|exported|merged`), `payload jsonb`, `created_at`). Index `(lead_id, created_at)`.
  - `lead_erasures` (`agency_id`, `phone_hash`, `erased_at`, `erased_by`). The hash is an HMAC-SHA256 under `LEAD_HASH_KEY` (Q9).
- `domain/leadStages.js`: `STAGES` (key, ar, en, emoji, order, `terminal`), `LOST_REASONS`, `canMove(from, to)` (any move; `lost` needs a reason), `stageLabel`.
- `domain/leadCard.js`: `leadCard(lead, { request, lang, forRole })` (broker card: name, displayed phone, stage, source, request summary, follow-up), `requestSummary(filters, lang)` (canonical filters → one line, the same words as the search refine form), `timelineLines(events, lang)` and `followUpLine`. It has no I/O, and nothing it returns is client-facing.
- `lib/authz.js`, still the single copy:
  - `canViewLead(broker, lead)`: same agency, and either a manager or the assigned broker (Q1).
  - `canEditLead`, the same rule.
  - `canManageLeads(broker)`: a manager. This covers assigning, the agency-wide list, export, erase and the pool.
  - `canViewDeal` / `canEditDeal` (Q10).
  - The single-`canEdit` test is extended: no second copy of any of these.
- `services/leads.js` returns data and sends no messages:
  - `captureLead(db, broker, { phone, name, source, lawfulBasis, request, note, channel })`: normalize the phone, check erasures, then insert, or **dedupe** on `(agency_id, phone_e164)`, which fills the blank name or source, adds an `inquiry` event, and never overwrites. It returns `{ status: created|merged|colleague|erased_before, lead, owner }`.
  - `assignLead`, `setStage`, `addNote`, `markContacted`, `setFollowUp`, `completeFollowUp`, `listLeads(db, broker, { stage, due, mine, q, page })` (role-scoped in SQL, not filtered afterwards), `getLead` (role-checked) and `timeline`.
  - Every write: a transaction, `SELECT … FOR UPDATE`, the authz check under the lock, a `version` check when the caller passes one, `last_activity_at = now()`, and one `lead_events` row.
- **Tests (unit + PGlite):**
  - Dedupe: the same phone in 4 spellings is 1 lead; colleague-owned returns `colleague`; an erased phone returns `erased_before`.
  - Role scoping: a broker can't list, get or edit a colleague's lead; an admin can.
  - Tenant isolation: agency B can't reach agency A's leads by id.
  - A stale version is a conflict, never an overwrite.
  - Stage rules: `lost` without a reason is refused.
  - Events are written for each action, and nothing else updates them.
  - Contract test: every new query is `agency_id`-scoped.

### 3. Intake on WhatsApp: forwarded text, voice, contact cards, and the assign card
- `domain/leadIntake.js` (pure):
  - `findPhones(text)` (Egyptian and international patterns, Arabic digits)
  - `parseContactCard(contacts)` (WhatsApp `contacts` message → name and phones)
  - `looksLikeLead(text)`: a phone, and no unit code or listing shape (price + area). A forwarded *unit* still goes to the listing flow (DEL-08 / draft).
  - `buildLeadPrompt` (fenced input, as in `buildListingPrompt`) and `normalizeLeadExtraction` (AI JSON → `{ name, phones, request: canonical filters via searchQuery.normalizeAiSearch, note }`; it never fills a field the AI left empty).
- `lib/leadIntake.js` is the WhatsApp adapter:
  - Contact card: the `contacts` case in `server.js` (today ING-06 "unsupported") goes to intake. It costs no AI call.
  - «ليد» / «عميل جديد» with text, or a voice note whose transcript starts with those words (added to `VOICE_COMMANDS`), goes to intake.
  - «ليد» alone opens a `lead_draft` session (`broker_sessions`, 30 min). The broker's next text, forward or voice goes into it, the same way a draft collects input.
  - A **forwarded text with a phone and no unit code**, outside any draft or edit, gets one prompt: "ده عميل؟" with **[➕ حفظ كعميل] [🔍 بحث]**. The text waits server-side in `broker_sessions` `pending_lead` (15 min), never in a button id (the COL-01 lesson).
  - Extraction: the phone comes from the regex first. The name and request come from one `lead_extraction` AI call (new `ROUTES` entry: 15 s deadline, 5 s hedge, fast thinking), counted in the AI quota. If the AI is down, the lead is still saved with the phone, and the broker is told the name and request weren't read.
- **Reply (one message):** the lead card (Q14), with the phone tappable, the `wa.me` link prefilled with "أهلاً <name>، معاك <broker> من <agency>…", and the buttons **[📞 كلمته] [📅 متابعة] [🔄 المرحلة]**.
  - On `merged`, the card says "العميل ده موجود — اتضاف استفسار جديد".
  - On `colleague`, there's no card. The broker gets the Q2 copy, and the owner gets a `notify` (`kind = lead_inquiry`).
- **Assign:**
  - Manager command «حول <phone or lead ref> لـ <broker name>», or the web assign control (step 4).
  - The new assignee gets the card by `notify` (`kind = lead_assigned`). The manager gets a one-line confirmation.
  - If the assignee's window is closed (`notify` returns null), the manager is told "اتحول، بس الإشعار موصلش — هيظهر له في الموقع".
- **Buttons** (`lib/buttons.js` `leadButtons(leadRef)`):
  - `lead_contacted:<ref>` logs `contacted` and moves `new` to `contacted`.
  - `lead_follow:<ref>` opens a list: بكرة / بعد 3 أيام / الأسبوع الجاي / تاريخ تاني.
  - `lead_stage:<ref>` opens a list of the stages; `lost` asks for a reason in a second list.
  - `<ref>` is the short per-agency lead number (`leads.ref`, shown as `L-0042`), so button ids stay well under 128 characters and the broker can type it.
  - Every button re-checks `canEditLead` under the lock.
- **Commands:** «عملائي» (my 5 most recent active leads plus "كلهم على الموقع: <link>"), «L-0042» (the card), «متابعات» (today's and overdue).
- Copy goes into `lib/copy.js`. The help menu lists the new commands (U1 rule: only working commands).
- **Router tests** (`tests/router/leads.test.js`):
  - Contact card → lead saved, card with phone and `wa.me`, 0 AI calls.
  - «ليد» + forwarded text → 1 AI call, name and request stored, 1 reply.
  - A voice note «عميل جديد اسمه…» → transcription + extraction → the same row as the text version.
  - A forwarded text with a phone → the prompt; tapping save → the lead; tapping search → a normal search.
  - A forwarded **unit** post still goes to the listing flow.
  - «عميل VIL-08» is still the client copy.
  - Dedupe across text, contact card and voice; colleague-owned → no card, owner notified.
  - AI down → saved with the phone only.
  - Buttons log events and change stages; an unauthorized colleague's button is refused.
  - Every turn answers in one message, and `wa_outbound` counts match.

### 4. Web CRM pages under `/app/`
Each page is a `web/routes/*.js` module listed in `PRIVATE`, with views in `web/views/`, CSRF on every write and `no-store`.
- `/app/leads`:
  - Tabs by stage, "متابعات النهارده" (due and overdue, including `undelivered`), search by name or phone, mine/all (managers), and an unassigned pool (managers).
  - Pages of 20. Each row is from `leadCard` (compact).
- `/app/leads/new`: name, phone, source, lawful basis, notes, an optional request (the search refine form, reused from `web/views/searchForm.js`), and "✨ املأ من الرسالة" plus 🎙️, both through the same `lead_extraction`.
  - The dedupe result is shown before saving: "موجود بالفعل → افتح".
- `/app/leads/<ref>`:
  - The card with real **`tel:` and `wa.me` buttons**, the stage control, the follow-up control (date and time), notes, and assign (managers).
  - The timeline, the buyer requests with their matches (step 6), and the deals (step 7).
  - Every write goes through `services/leads.js` with the version the page was opened at; a change made meanwhile is a 409 conflict.
- The home page shows "عملائي" and "متابعات النهارده" counts.
- Rate limits: `LIMITS.leadExtractBroker` (20 / 10 min, the same as `extractBroker`) and `LIMITS.leadWriteBroker` (120 / min).
- Telemetry: `web_lead_create`, `web_lead_update`, `web_lead_extract`.
- **Supertest tests** (`tests/web/leads.test.js`):
  - List scoping per role (a broker never sees a colleague's lead by list, by URL, or by search for their phone).
  - Create, and the dedupe notice.
  - The stage, follow-up and note round trip, with events written.
  - A version conflict with a WhatsApp button tap.
  - Assign by a manager: the assignee is notified, and the old broker gets a 404 afterwards.
  - CSRF and cross-site refusal.
  - Tenant isolation.
  - `no-store` on every page; HTML-escaping of a lead name like `<script>`.

### 5. CSV / Excel lead import
- `domain/leadImport.js` (pure, the twin of `domain/sheetImport.js`):
  - `COLUMNS` (the Q11 headers in Arabic and English) and `rowToLead`.
  - Per row: `new`, `merge` (the phone exists: it fills blanks and adds an `inquiry` event; it never overwrites a name or stage), `colleague`, `invalid` (no or bad phone, with the reason), `erased_before`, `repeated` (the same phone earlier in the file, merged into the first row).
- `lib/sheets.js` gains `readCsv(buffer)`. It runs in memory with a BOM, comma or semicolon, quoted fields and the same 5 MB / 2,000-row caps. Cells are sanitized (SEC-05) on the way out to any workbook.
- `services/leadImports.js` uses the existing `web_imports` plan → preview → apply-once flow (**migration `012_lead_imports.sql`** adds `leads` to the `kind` CHECK).
  - Apply runs each row in its own transaction through `captureLead`.
  - Requests columns become a `saved_searches` row with `lead_id` (step 6).
  - It needs the Q7 confirmation tick, and it's managers only by default (brokers may import their own leads; Q3).
- `/app/leads/import` (upload, preview with counts per kind, assign options, apply) and `/app/leads/import/template.xlsx`.
- **Tests:**
  - Arabic and English headers.
  - CSV with BOM and semicolons; `.xlsx`.
  - Dedupe within the file and against the database.
  - A colleague's lead is not reassigned.
  - Erased phones are flagged.
  - Nothing is written before apply; a second apply returns 409.
  - The confirmation tick is required.
  - Formula-looking cells don't run (a `=HYPERLINK` name stays text).
  - Round-robin assignment is even.
  - Tenant isolation and private plans; the upload rate limit.

### 6. Buyer requests and match alerts
- **Migration `013_buyer_requests.sql`:**
  - `saved_searches.lead_id uuid` (ON DELETE CASCADE) and `alerts_enabled boolean NOT NULL DEFAULT false` (true for lead requests).
  - `lead_matches` (`agency_id`, `saved_search_id` ON DELETE CASCADE, `listing_id` ON DELETE CASCADE, `matched_at`, `alerted_at`, `status` `new|alerted|sent_to_client|dismissed`; unique `(saved_search_id, listing_id)`).
  - `share_links.lead_id` (SET NULL).
- A buyer request is a saved search owned by the lead's assigned broker, with `lead_id` set. Reassigning a lead moves its requests to the new broker in the same transaction. A lead may have up to 3 requests.
  - On WhatsApp: «طلب <text>» while a lead card is the last thing shown, or as part of the lead intake text. The text runs through `Search.parseRequest` (the existing `search_parse` route and local fallback). The reply shows the request summary and **the current matches** (the `compactLine` + `featuresLine` of up to 5) in one message.
  - On the web, the lead page's request form is the refine form.
- **Match sweep** (scheduler job `lead_matches`):
  1. Read listings with `(updated_at, id) > watermark` in the agency, active only, up to 500 per tick.
  2. For each agency with alerting requests, run each request's filters through **`buildSearchQuery(agencyId, filters, { relaxed: false })` with an extra `AND l.id = ANY($n)`** for the changed ids, in one query per request. That's the same SQL as search, so "what alerts" equals "what search shows".
  3. Insert `lead_matches` rows `ON CONFLICT DO NOTHING`; only new rows alert.
  4. Group per assigned broker into one `notify` (`kind = lead_match`, Q6 cap of 10 a day), then advance the watermark.
  - The request's `seen_ids` and the web "🆕 N جديد" count keep working (WEB-08).
- **"ابعت للعميل":**
  - From the match alert (a button per match, through a list) or the lead page, it creates a share link with `lead_id` (`lib/shareLinks.js` `createShareLink` gains `{ leadId }`).
  - It returns a `wa.me/<lead phone>` link prefilled with the unit's `Describe.clientCopy` + `🔗` link, for the broker to send.
  - It logs `match_sent` and sets the match status. When the client opens it, the opened alert names the lead to the broker (WEB-19 + `share_opened` event on the lead).
- **Tests:**
  - Router: a request by text → summary + current matches; a voice request gives the same filters.
  - The scheduler: a new unit added by the WhatsApp draft, the web form, an import and a quick update "available" each alert exactly once.
  - A price drop into range alerts; a rollback alerts nothing; a sold unit never alerts.
  - Two requests of the same broker → one message; the 10/day cap.
  - Parity: the sweep's ids equal `services/search.js` strict results for the same filters.
  - Tenant isolation (agency B's units never match agency A's requests).
  - Send to client: the share link has `lead_id`, the public page shows no lead data (sentinel name and phone), and the opened alert names the lead.

### 7. Follow-up reminders
- Scheduler job `follow_ups`:
  1. Pick leads with `follow_up_status = 'open' AND next_follow_up_at <= now()`, outside quiet hours (Q5), `FOR UPDATE SKIP LOCKED`.
  2. Group them per broker into one `notify` (`kind = lead_follow_up`, up to 5 lines + "و N كمان على الموقع: <link>").
  3. Set `reminded` or `undelivered`.
  - The "no contact for 24 h" nudge uses the same job, once per lead.
- Buttons in the reminder: [✅ تم] [📅 أجّل] (list).
- **Tests** (scheduler `tick({ now })` with a fixed clock):
  - Date-only → 10:00 Cairo.
  - Quiet hours hold until 08:00.
  - One message for 7 due leads.
  - A closed window → `undelivered`, shown on the web list.
  - Done and postpone buttons work.
  - Two pods tick at once → one message.
  - A reassigned lead reminds the new broker.

### 8. Deals and commission
- **Migration `014_deals.sql`:**
  - `deals`:
    - `id`, `agency_id`, `lead_id` (SET NULL), `listing_id` (SET NULL), `closing_broker_id`
    - `deal_type` `sale|rent`, `market` `resale|primary`, `price`, `commission_mode` `pct|fixed`, `commission_pct`, `commission_total`
    - `external_co_broker` (internal text), `external_share`
    - `status` `pending|signed|paid|cancelled`, `signed_at`, `paid_at`
    - `client_name`, `client_phone` (cleared on erasure), `notes`, `created_at`, `updated_at`, `version`
  - `deal_splits` (`deal_id` ON DELETE CASCADE, `agency_id`, `broker_id`, `share_pct`, `amount`; the shares per deal sum to 100).
  - A check that `listing_id` and `lead_id` belong to `agency_id`, by trigger.
- `domain/commission.js` (pure):
  - `computeCommission({ dealType, market, price, mode, pct, fixed, monthlyRent, settings })`
  - `splitPool({ total, externalShare, brokerSharePct, splits })` → amounts in whole EGP, with the remainder to the closing broker
  - `validateSplits`
  - Reference cases are written like F1–F10 (at least 10: resale 2.5%, rent one month, primary fixed, an external co-broker, 3-way splits with rounding, 0%, refusing >100%).
- `services/deals.js`: `createDeal` (from a lead and a unit; it sets the lead to `won` and the unit to `sold` through `applyListingPatch` in the same transaction when the broker ticks "علّم الوحدة مباعة"), `updateDealStatus`, `listDeals` (role-scoped, Q10) and `monthlyTotals` (managers).
- **Web:** `/app/deals` (list, the month's totals per broker for managers, "my commission" for brokers) and `/app/deals/new?lead=&unit=`. On the lead page, "🤝 سجل صفقة".
- **WhatsApp:** «صفقة L-0042 VIL-08 8.5 مليون» opens a review card (price, commission, split) with [تأكيد ✅] [تعديل ✏️] [إلغاء ❌]. It's staged in `broker_sessions` `deal_draft`, like the draft review. Commission figures are never part of any client copy.
- **Tests:**
  - Commission reference cases.
  - A deal marks the unit sold (optimistic lock respected; a conflict refuses the whole deal).
  - The lead becomes won.
  - A broker sees only their own deals and share; a manager sees the totals.
  - Tenant checks on `listing_id`/`lead_id`.
  - Router: the WhatsApp deal review → confirm → the rows; a double tap saves once.
  - The golden describe tests still show no commission in the client copy.

### 9. PDPL: export, erase, retention, payload purge
- `services/privacy.js`:
  - `exportLead(db, broker, leadId)`: managers only; lead + requests + events + deals, with other people's data left out; one `exported` event.
  - `eraseLead(db, broker, leadId, { reason })`: managers only; in one transaction, write the `lead_erasures` hash, clear the deal client fields, then delete the lead (cascades: events, requests, matches; `share_links.lead_id` → NULL). It writes `operation_logs` `lead_erased` with ids only.
  - `retentionSweep` (scheduler, daily at 03:00 Cairo): mark leads that are 30 days from the limit, then erase leads past `LEAD_RETENTION_MONTHS` with `erased_by = NULL` (system).
  - `purgeInboundPayloads`: `UPDATE inbound_messages SET payload = '{"purged":true}'::jsonb` for rows in `completed|failed` older than `INBOUND_PAYLOAD_DAYS` (**P2**). `payload` is `NOT NULL`, so no migration is needed. Dedup only needs `msg_id`, and crash recovery only replays `new|batched` rows.
- **Web:** on the lead page (managers), "⬇️ تصدير بيانات العميل" (a zip with `.json` + `.txt`, `Content-Disposition: attachment`, `no-store`, a rate limit of 10/hour) and "🗑️ مسح بيانات العميل" (typed confirmation: the last 4 digits of the phone). The privacy note text comes from `crm_settings`.
- **Tests:**
  - Export content: complete for the lead, nothing about other leads or colleagues' phones.
  - Erase removes every row in every CRM table, and a deal survives without client fields.
  - A re-intake of the erased phone warns.
  - The retention sweep with a fixed clock (warn at −30 days, erase at the limit, active leads untouched).
  - The payload purge leaves recent and pending rows alone, and `bootRecovery` still works.
  - Non-managers get 403.
  - **P3:** after a full CRM flow, no `operation_logs` row, log line or `wa_outbound` metadata contains the sentinel phone or name.
  - **Public pages:** a sentinel lead linked to a share link is absent from the page HTML and the OG tags.

### 10. User docs, runbook and Release 4 prep
- **`docs/pilot/crm-howto-ar.md`**: the Arabic CRM guide for brokers, in the style of `broker-howto-ar.md`. It covers:
  - saving a client (forward, contact card, «ليد», voice, CSV for managers)
  - the card and its buttons
  - stages and follow-ups
  - buyer requests and "ابعت للعميل"
  - deals and commission
  - who sees what
  - what to do when a client asks to be deleted
  - a short "اعمل ولا تعمل" for client data: don't paste client phones into groups, use the export button instead of screenshots
- `broker-howto-ar.md` and `web-howto-ar.md` link to it; `docs.test.js` checks it exists and is linked.
- **`docs/runbook.md`:**
  - The new env vars (`SCHEDULER_ENABLED`, `SCHEDULER_TICK_MS`, `LEAD_RETENTION_MONTHS`, `INBOUND_PAYLOAD_DAYS`, `LEAD_HASH_KEY`; also added to `render.yaml` as `sync: false` where secret).
  - The scheduler (one pod per job, how to read `crm_job_*` rows).
  - How to handle a deletion or export request (the manager path, and the SQL fallback with an audit row).
  - The retention settings, setting `crm_settings` (commission defaults, privacy note) for an agency.
  - New `operation_logs` types (`lead_*`, `crm_job_*`, `wa_outbound` kinds `lead_assigned|lead_inquiry|lead_match|lead_follow_up`) and queries for leads per broker and stage, undelivered reminders, and match alerts per day.
  - **`LEAD_HASH_KEY` rotation**: rotating it weakens the erasure warnings for earlier erasures. That's documented and accepted.
- **Meta message templates for Release 4 must be submitted** (runbook §9 is updated): the **morning brief** and **"still available?"**, which were already due, plus two **utility** templates for this release: the **follow-up reminder** and the **match alert**. Release 3 can only send these inside the broker's 24-hour window. With the templates approved, Release 4 sends them at any time. Approval can take days, so submit them while Release 3 is being built.
- `ARCHITECTURE_MANIFEST.md` gains §7.G "CRM"; `FEATURE_REGISTRY.md` gains a §"CRM (`CRM`) — Release 3" table (CRM-01…), coverage map rows, and defect IDs P1–P3.

## Tests (full, per step above), and what stays green
- The whole existing suite, plus the new files `tests/router/leads.test.js`, `tests/router/deals.test.js`, `tests/web/leads.test.js`, `tests/web/lead-import.test.js`, `tests/web/deals.test.js`, `tests/web/privacy.test.js`, `tests/unit/phone.test.js`, `tests/unit/lead-domain.test.js` (stages, card, intake parsing, import mapping), `tests/unit/commission.test.js` and `tests/unit/scheduler.test.js`.
- The harness gains `insertLead`, a fixed-clock `tick`, and a fake WhatsApp `contacts` payload builder. `TRUNCATE` covers the new tables.
- Contract guard, schema reference and docs tests in every commit.

## Cost notes
**WhatsApp messages per task** (each answers in one message):

| Task | Messages |
| --- | --- |
| Save a lead (any channel) | 1 reply |
| Assign | 1 notify to the assignee + 1 reply to the manager |
| Button tap (contacted, stage, follow-up) | 1 reply (the list prompt counts as the reply) |
| Request | 1 reply with the matches |
| Follow-up reminder | 1 per broker per sweep with due items (not per lead) |
| Match alert | 1 per broker per sweep, at most 10 a day |
| Deal | 1 review + 1 confirmation |

**Pilot estimate** (5 brokers, 22 working days): about 10 intakes, 10 updates, 4 reminder messages and 3 alert messages a broker a day ≈ **3,000 messages a month**.
- At the repo's working rate (1,000 free a month, then about 0.19 EGP), that's about **380 EGP a month**. Mostly service-window replies; check against Meta's current pricing when the Release 4 metering lands.
- The web is the cheaper surface for bulk work (lists, imports); the guide says so.

**AI calls:**
- Contact card, CSV, buttons, matches and reminders: **0**.
- Forwarded text: **1** `lead_extraction` (flash tier, about 1–1.5k input tokens; under $0.001).
- Voice: **2** (transcription + extraction).
- Request: **1** `search_parse` (or 0 with the local parser).
- All of it is counted in the existing daily quotas, with a new route in the eval set: **8 lead extraction cases** (name, phone written out in Arabic words, budget, compound) added to `tests/eval/cases.json`.

**Database:** the match sweep is one query per alerting request per tick. That's a few hundred indexed queries at pilot scale, bounded by `LIMIT` and the 500-listing batch. Memory doesn't change (no new worker).

## Security review (to do at the end of step 9, recorded in the manifest)
- **Access:** every lead, deal, request and match read goes through the role-scoped `services/*` functions. A test asserts that no route queries those tables directly (a grep test, like the single-`canEdit` test).
  - The 404-not-403 rule for leads a broker can't see, so a lead's existence isn't revealed. The Q2 colleague notice is the one deliberate exception: it gives a name and no details.
- **Tenant isolation:** the contract test covers the new tables, and foreign keys can't cross agencies (triggers).
- **Injection:** CSV and Excel cells are sanitized on output; HTML is escaped by `html```; AI prompts are fenced; button ids carry only `L-<n>` refs.
- **PDPL:**
  - lawful basis recorded on every lead
  - access by role
  - export and erasure by managers, with an audit row
  - retention sweep
  - inbound payload purge (P2)
  - no personal data in telemetry or logs (P3)
  - no lead data on public pages (sentinel test)
  - the export never cached
- **Abuse:** rate limits on intake AI, writes, imports and exports. Match alerts and reminders are capped per day. All pending state is server-side (`broker_sessions`), never in button ids.
- **Secrets:** `LEAD_HASH_KEY` is required in production (fail-fast, added to `REQUIRED_IN_PRODUCTION`).
- `/security-review` runs on the branch diff before the merge, and its findings are fixed or answered in the final progress note.

## Verification
- `npm run test:ci` is green after every step, and `npm run eval:ai` on the lead cases is at 90% or better of fields on the paid key (run locally if the cloud has no key).
- **Manual run** on a phone (or `scripts/send-webhook.js`):
  1. Forward a client's contact card to the bot. A card arrives with a tappable phone and a `wa.me` link; no AI call shows in `operation_logs`.
  2. Send a voice note: «عميل جديد اسمه أحمد، عايز شقة ٣ غرف في ماونتن فيو لحد ٩ مليون». The lead and its request are saved, and the reply shows current matches.
  3. Add a matching unit by WhatsApp. Within about a minute, one match alert arrives. Tap "ابعت للعميل", send it, and open the link in a private browser window: the page shows the unit and nothing about Ahmed, and the broker gets "أحمد فتح الرابط".
  4. Set a follow-up for "بكرة" and move the scheduler clock (or wait). One reminder arrives at 10:00 Cairo.
  5. As a second broker, try `L-0001` and open `/app/leads/<ref>`: not found. As the admin, both work.
  6. Record a deal at 8.5M with a 2.5% commission split 60/40. The amounts are whole EGP and sum exactly; the unit is sold and the lead is won.
  7. As the admin, export, then erase the lead. Every CRM row is gone, the deal remains without the client name, and re-forwarding the same contact warns that they asked to be deleted.
  8. Check `operation_logs` and the Render logs for the client's phone and name: none.

## Critical files (Release 3)
- `domain/phone.js`, `domain/leadStages.js`, `domain/leadCard.js`, `domain/leadIntake.js`, `domain/leadImport.js`, `domain/commission.js`: new, pure
- `services/leads.js`, `services/leadImports.js`, `services/deals.js`, `services/privacy.js`: new
- `lib/scheduler.js`, `lib/leadIntake.js`: new. Touched: `lib/authz.js`, `lib/registry.js`, `lib/buttons.js`, `lib/copy.js`, `lib/rateLimit.js`, `lib/shareLinks.js`, `lib/sheets.js`, `lib/ai.js` (route), `lib/util.js`, `lib/onboarding.js`
- `server.js`: the `contacts` case, scheduler start and stop
- `web/routes/leads.js`, `web/routes/leadImport.js`, `web/routes/deals.js` and `web/views/leads.js`, `web/views/deals.js`: new. Touched: `web/routes/index.js`, `web/routes/home.js`
- `db/migrations/010_crm_settings.sql` … `014_deals.sql`
- `config.js`: the new env vars; `LEAD_HASH_KEY` in `REQUIRED_IN_PRODUCTION`
- `tests/harness/*`, `tests/router/*`, `tests/web/*`, `tests/unit/*`, `tests/eval/cases.json`
- `docs/pilot/crm-howto-ar.md` (new), `docs/runbook.md`, `ARCHITECTURE_MANIFEST.md`, `FEATURE_REGISTRY.md`, `API_CONTRACTS.json`, `SCHEMA_REFERENCE.sql`, `render.yaml`

## Deferred (not in Release 3)
- Lead Ads intake, the Conversions API, a viewing scheduler (already deferred in the Release 1 plan).
- Messaging clients from the bot number (needs client opt-in and marketing templates).
- Auto round-robin by load, lead scoring, a pipeline board UI (drag and drop).
- The morning brief, web push, the action pool and the leaderboard: Release 4.
