# AqarChat POC: pre-build review and build plan

## Context
The business analysis (Claude Doc "AqarChat — Business Analysis", tabs v2–v7) settled the product. It is a WhatsApp front door, with a website (PWA) as the engine room, sold to agencies at 1,500–2,000 EGP a month. The pilot is one design-partner agency with 3–5 brokers.

Remediation Batches 1, 2a and 2b are done:
- the PGlite harness and CI
- reply truth
- the hedged AI gateway, telemetry and eval

The working tree is clean (`daeada9`).

The POC is delivered as **four releases**. **Release 1, the WhatsApp-only slice, is what we build now** (about 2–3 days).

**Working mode for the POC:**
- Claude writes all the code.
- **Full tests** ship with every change.
- **The doc updates are paused** (ARCHITECTURE_MANIFEST, FEATURE_REGISTRY, API_CONTRACTS). This is a POC-only exception to the standing rule, and a docs batch returns before agencies beyond the pilot.

## Locked decisions
- **Developers as users:** out of scope. Agency-marketed primary units and resale-with-installments are in.
- **Every captured detail appears in the description:**
  - Covers delivery, extras, the remaining installments, orientation (بحري/قبلي), corner (ناصية), view, nanny room, driver room, master, dressing, roof, garden, furnished, appliances and the rest.
  - Unknown fields are left out silently. Nothing is invented.
  - **Field warnings (for example `⚠️ موعد التسليم غير مسجل`) appear only while adding or editing.** They never reach clients, search results or the brief.
- **Delivery date:** optional. When it's known it's highlighted like rooms and bathrooms (`🗓 تسليم 2027 Q3`, or `🔑 استلام فوري`).
- **Extras and features:** a fixed bilingual list of keys plus a free-text "other". The same list feeds descriptions, search filters and the search text.
- **Resale schedule:** stores the remaining amount, installment amount, frequency and end date. Years left is computed when shown.
- **Search:**
  - One service for WhatsApp and the web, text and voice. The same input gives the same results in the same order.
  - Arabic, English or mixed input maps to the same language-neutral filters.
- **Web stack (Release 2):** Express + htmx + PWA, in the same app. Next.js comes later, for SEO sites only.
- **URLs:** every link is built from `PUBLIC_BASE_URL`. Use `https://<service>.onrender.com` until the domain exists, then `www.aqarchat.com`. Public pages are `/<agency-slug>/<unit-code>?s=<share-token>`.
- **Hosting:** Render. Start on Starter ($7). Move to Standard ($25) if measured peak memory stays above about 400 MB.
- **Gemini:** enable billing now, with a budget alert, for the eval runs. Billing is mandatory before the pilot.

## Field rules
**Mandatory** blocks saving. **Warning** appears in the add/edit review only. **Optional** is never asked about. Extras and features are always optional.

| Unit case | Mandatory | Warning (add/edit only) |
| --- | --- | --- |
| All units | Sale or rent; property type; compound (or district and city); area; price (monthly rent for rentals) | Photos, finishing |
| Apartment, duplex, penthouse | + bedrooms | Bathrooms, floor |
| Studio | Bedrooms set to 0 automatically | Bathrooms, floor |
| Villa, townhouse, twin house | + bedrooms; area means BUA | Land area, bathrooms |
| Office, shop, clinic | No bedrooms | Floor |
| Resale paid in cash or ready | — | Delivery (or "ready") |
| Resale with installments | + two of: total price, cash paid, remaining amount (the third is derived) | Installment amount, frequency, end date; delivery; a total vs. paid + remaining mismatch over 100 EGP |
| Primary unit | + price, plus at least one plan (down payment %, years, frequency) or a cash price | Project or developer; delivery; maintenance terms (unknown shows "حسب التعاقد") |
| Rent | Monthly rent | Furnished status |

**Search result line** (`describe` compact mode, identical everywhere):
- Line 1: code · type · compound · price · area · 🛏 · 🛁 · 🗓 (only if known) · payment hint (كاش / مقدم 10% · 8 سنين / متبقي 1.2M) · ✅ confirmed date.
- **Line 2, the features line**, for example `بحري · ناصية · غرفة مربية · فيو جاردن`. It's cut with "+N" when long. The web shows all features as tags.

**Customer version:** everything except internal data (owner name and phone, notes, commission, co-broker identity).

**Search filters:**
- compound (bilingual), district or city
- type, sale or rent
- price, area, bedrooms, bathrooms
- delivery (ready, or by year)
- payment (cash, installments, maximum down payment, maximum installment)
- primary or resale, finishing
- features (ناصية, بحري, club, garage...)
- floor

## Review findings (architecture, performance, cost, UX, security)
- **Architecture:**
  - `lib/db.js` is required by nothing, and `server.js:531` creates its own pool with no `statement_timeout`.
  - Prices are hardcoded (`lib/db.js:207`, `lib/search.js:935`).
  - Routing is an ordered regex chain (`routes/commands.js:451`), and `canEdit` is duplicated.
  - There are no migrations, and nothing writes `payment_terms`.
  - Target layering: `routes` → `registry` → `services` (return data) → `domain` (pure). Release 1 only builds the parts it touches.
- **Data:**
  - Delivery is free text split across the column and `details`, and formatters read different places.
  - `composeFields` never sets the top-level columns.
  - Excel mapping bugs, plus a default of 1 bedroom.
  - The 4 search triggers conflict (D1), and the two normalizers mismatch (D2).
- **Performance:**
  - Flyer, Excel and vision work moves to `worker_threads` before the website shares the event loop.
  - Targets: search parse p50 under 3 s; draft extraction p50 about 12 s with the typing indicator.
- **Cost:**
  - About 0.19 EGP per WhatsApp reply after 1,000 free a month per number. The pilot fits inside the free tier.
  - Release 1 logs outbound message counts per agency, so the pool can be sized later.
  - Fix the flyer from 2 messages to 1. Keep search at 1.
- **UX:** one `describe` template, one button catalog and one copy helper, so WhatsApp and the web stay consistent. Target 1 message per task.
- **Security:**
  - Fail-closed `WHATSAPP_APP_SECRET`, body limit, tenant-scoped queries with a contract test.
  - Release 2 adds the magic-link GET→POST, CSRF, share tokens, an allowlist serializer for public pages, and PDPL items for leads.

## Release 1: WhatsApp-only slice (build now)

1. **Foundation**
   - `config.js`: env, `PUBLIC_BASE_URL`, model prices and quotas; fails fast in production.
   - `lib/db.js` becomes the single pool, with NUMERIC/BIGINT parsers, `statement_timeout` and SSL.
   - `db/migrations/` plus `scripts/migrate.js`; the harness applies `schema.sql` and then the migrations.
   - ctx carries `broker` and `agency`, so telemetry IDs are never null.
   - Costs come from config prices.
   - An outbound message counter per agency, in `deliver()` (`lib/dispatcher.js`).
   - Body limit, fail-closed secret, pinned dependencies.
2. **Listing data model** (migration)
   - Structured delivery (`delivery_year`/`quarter`/`month`, `is_ready`, `delivery_raw`), backfilled from both sources.
   - Extras and features (fixed keys plus `features_other text[]`).
   - The resale schedule.
   - `confirmed_at`.
   - `code_norm` with a unique index.
   - The bilingual feature dictionary in `domain/features.js`.
3. **Draft pipeline** (Batch 3)
   - Port v1.8 `extractPropertyDetails`/`finalizeDraft` (A1/A2) through `AI.generateWithCascade`, with the new fields and features in `buildListingPrompt` (`lib/listing.js`).
   - `domain/fieldRules.js` holds the field table above and drives the review card.
   - `draft_confirm` commits only the staged review.
   - Insert-only commit; error 23505 replies "الكود مستخدم".
   - Photos go to storage at ingest.
   - `composeFields` sets the top-level columns.
   - About 10 new eval cases (delivery, ناصية/بحري, view, resale schedule).
4. **One description template and financial fixes** (Batch 4b)
   - `domain/describe.js` covers: broker card, client copy (Arabic and English), search compact line plus features line, plan copy, and the flyer model.
   - It replaces the formatting in `lib/text.js` (`formatClientListingText`, `formatInternalListingDetails`, `formatSearchResults`) and `lib/financials.js` (`formatSinglePlanAdCopy`).
   - Fix F1–F10 and C1–C7. Store the Q-F maintenance terms as data.
5. **Search** (Batch 6, D1/D2)
   - One trigger builds a bilingual search text, and there's one normalizer.
   - A `compound_synonyms` table seeded from `BILINGUAL_COMPOUND_MAP` (`lib/search.js:51`).
   - The parser outputs language-neutral filters, including delivery, payment and features.
   - Fixes:
     - B1: an id snapshot for "more"
     - B2: an intent guard
     - B3/B4: draft and search collision
     - B6/B7: code case and index use
   - One `services/search.js` shared by text and voice, ready for the web.
6. **Edits and quick updates** (part of Batch 4)
   - `applyListingPatch` with optimistic locking.
   - Sold, archive, price and available by text, voice or button, each setting `confirmed_at`.
   - Fix A3–A5.
   - A partial command registry covering the touched commands.
   - `lib/authz.js` replaces both `canEdit` copies.
   - The button catalog and copy helper, for the touched messages.
7. **Flyer: plumbing and visual check** (Batch 7 subset)
   - One pipeline (`renderFlyerOnDemand`; delete `deliverFlyer`, A7/V1), running in `worker_threads` with a limiter.
   - One message with a caption. The model reads from `describe`.
   - Render the sample set to PNGs:
     - resale cash
     - resale with installments
     - primary with plans
     - villa, studio, rent
     - no photos, no logo
     - a long Arabic name with many features
   - Review the PNGs together, then fix overflow, RTL, digits, empty sections and the feature icons.
   - Keep the samples as regression snapshots.
   - Measure peak RSS to settle the Render plan.
8. **Pilot setup**
   - `scripts/onboard.js` (agency, brokers, roles, branding).
   - Run `npm run eval:ai` on the paid key and confirm 95% or better of fields.
   - Deploy to Render Starter.
   - Send the brokers a short Arabic how-to message.

**Release 1 tests (full):** the existing suite stays green, plus:
- Router tests: add by voice or text, then review (warnings shown only here), confirm, then the stored row.
- A code collision doesn't overwrite.
- Quick updates.
- Golden description tests across 7 unit cases × every surface: all captured fields present, nothing internal in the client copy, no warnings outside add/edit.
- Financial reference cases (F1–F10).
- Search parity: voice vs text; Arabic vs English vs mixed pairs return identical id lists; relaxed pass then "more".
- Tenant isolation.
- Flyer snapshots.
- Every `known-defects` case that this release fixes becomes a normal test.

## Later releases (planned, not built now)
- **Release 2: Website** (about 4–6 days)
  - `agencies.slug`.
  - Web shell: RTL, htmx, PWA, service worker scoped to `/app/`.
  - Magic-link login (GET→POST, hashed tokens, 30-day sessions), CSRF, rate limits.
  - Web search on `services/search.js`, with "refine and see all" from WhatsApp and saved searches.
  - Add/edit form with photos and a voice button.
  - Excel diff import, bulk edit, and group import (forwarded posts and chat export).
  - Public unit pages `/<slug>/<code>?s=` with OG tags, `noindex`, opened alerts, and the allowlist serializer.
- **Release 3: Core CRM** (about 3–5 days)
  - `leads` and `lead_events`.
  - Intake from forwarded text, voice or CSV, with dedupe.
  - Assign with a `[Call][WhatsApp]` card.
  - Stages and follow-ups.
  - Buyer requests (`saved_searches.lead_id`) with match alerts.
  - Deals and commission.
- **Release 4: Operations** (about 3–5 days)
  - Action pool metering with link fallback and 80%/100% alerts.
  - Morning brief: Meta template, "still available?", auto-hide after 30 days. **Submit the templates during Release 2.**
  - Web push.
  - Leaderboard and owner dashboard.

**Deferred until after the pilot:**
- listing aliases, public ref, RLS
- streaming Excel
- vision V2–V7
- splitting large files and the i18n catalog
- a separate worker service
- viewing scheduler, Lead Ads intake, Conversions API
- the flyer redesign
- the paused docs batch

## Handoff: run the build in the cloud (laptop can be closed)
1. **First action after approval, done locally:**
   - Copy this plan into the repo as `docs/plans/poc-release-1.md`.
   - Create the branch `poc/release-1`, commit, and push to GitHub. A cloud session can't see `C:\Users\...\.claude\plans`.
2. **You, once:** open claude.ai/code (or Code in the Claude desktop or mobile app).
   - Connect GitHub and pick this repo.
   - Create an environment with a setup script of `npm ci`.
   - No secrets are needed: the tests use PGlite and the fakes.
   - Add `GEMINI_API_KEY_*` only if the eval should run in the cloud. Otherwise run the eval locally later.
3. **Start the session** with: "Implement `docs/plans/poc-release-1.md` Release 1 on branch `poc/release-1`, one step at a time. Run `npm run test:ci` after each step, commit each step, push, and open a PR at the end. Ask me when a decision is needed."
4. **Notifications:** install the Claude mobile app on the same account and allow notifications. Cloud Code sessions appear there, and you can reply from your phone when input is needed. *Check the exact notification setting in the app.*
5. **Stays with you:**
   - reviewing and merging the PR
   - the Render deploy
   - real-phone checks
   - the flyer PNG review (the session attaches the samples to the PR)

## Critical files (Release 1)
- `server.js`: ctx, mounting config
- `lib/db.js`: becomes the single pool
- `config.js`, `db/migrations/*`, `scripts/migrate.js`: new
- `lib/dispatcher.js`: the message counter
- `lib/listing.js`, `lib/drafts.js`: extraction, `composeFields`, commit
- `domain/describe.js`, `domain/fieldRules.js`, `domain/features.js`: new
- `lib/text.js`, `lib/financials.js`: formatting delegated to `describe`
- `lib/search.js`, `services/search.js`: search
- `routes/commands.js`, `routes/interactive.js`: touched commands moved onto the registry
- `lib/authz.js`: new
- `lib/flyer.js`: one pipeline, worker
- `tests/harness/app.js`, `tests/router/*`, `tests/unit/*`, `tests/eval/cases.json`: tests and eval cases

## Verification
- `npm run test:ci` green after every step, and `npm run eval:ai` at 95% or better on the paid key.
- Manual run on a phone (or `scripts/send-webhook.js`):
  1. Voice-add a resale installment unit described as "بحري ناصية فيها غرفة مربية" with no delivery date. The review warns about delivery. The saved card, client copy and search line show every feature and no delivery line or warning.
  2. Search "Mountain View 3 bedrooms" by text, then "ماونتن فيو ٣ غرف" by voice. Same units, same order.
  3. Say "اتباعت VIL-08". The unit is sold, `confirmed_at` is set, and it's gone from search.
  4. Request a flyer. One message arrives, and the visual matches the approved samples.
  5. Check `operation_logs`: no null agency IDs, costs come from config, message counts are logged.
