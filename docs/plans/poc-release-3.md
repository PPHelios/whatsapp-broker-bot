# AqarChat POC: Release 3 (Core CRM) build plan

## Context
Release 1 (the WhatsApp-only slice) and Release 2 (the website: `/app/` and the public unit pages) are merged to `main` and running on Render. The pilot is still one design-partner agency with 3–5 brokers.

Release 3 is the **Core CRM** from `docs/plans/poc-release-1.md` "Later releases → Release 3":
- `leads` and `lead_events`
- intake from forwarded text, voice or CSV, with dedupe
- assigning a lead with a `[Call][WhatsApp]` card
- stages and follow-ups
- buyer requests (`saved_searches.lead_id`) with match alerts
- deals and commission
- the **PDPL items for leads** (Law 151/2020): lawful basis or consent, retention, deletion and export on request, access limited by role, and no lead data on public pages

The owner's review (2026-10-25) added the following:
- a notification centre, so alerts can go through the website (web push) instead of WhatsApp, and later through Telegram
- an assessment of moving to Telegram
- a product review and a UX review
- English for onboarding, the guides and every command
- both languages everywhere except the flyer, which stays English-only

These are folded into the steps below.

Leads are the first **personal data about people who are not our users**. They are the agency's clients. That raises the security bar for everything in this release.

**Estimate:** about 5–7 days (the CRM core is 3–5 days, plus the notification centre, the bilingual pass and the wow features).

**Working mode:**
- Claude writes all the code.
- **Full tests** ship with every change:
  - router tests on the real webhook (`createApp(...).handleWebhookBody`)
  - supertest web tests on the same `createApp`
  - unit tests for every `domain/` module
  - all of them on the PGlite harness (`tests/harness/`) and the fakes
- **Docs are updated every step** (the standing rule, ARCHITECTURE_MANIFEST §8):
  - `ARCHITECTURE_MANIFEST.md`
  - `FEATURE_REGISTRY.md` (new `CRM-*` and `NTF-*` features, coverage rows, defect IDs)
  - `API_CONTRACTS.json` (`node scripts/api-contracts.js`)
  - `SCHEMA_REFERENCE.sql` (`npm run schema:reference` in every migration commit)
  - `docs/runbook.md`
- `tests/contract-guard.test.js` and `tests/unit/docs.test.js` stay green at every commit.
- After each step: run `npm run test:ci`, commit, push `poc/release-3`, and send a short progress note. Merge to `main` when every step is green (the Release 1 merge policy).
- The cloud test `DATABASE_URL` holds no production data. **Never clear `operation_logs`.**

## Current design (open to discussion)
Nothing is locked; any of this can be reopened when a reason appears. Release 3 keeps the following, because the CRM gets cheaper by reusing it:
- **Layering:** `routes` → `lib/registry.js` → `services` (return data) → `domain` (pure). CRM commands never go into the legacy regex chain.
- **One send path:** `lib/dispatcher.js`. Release 3 puts a channel layer in front of it (step 2), so the same alert can go to web push, WhatsApp or, later, Telegram.
- **One search service:** buyer requests are canonical filters, run by `services/search.js` `buildSearchQuery`. Match alerts use the same SQL that search uses.
- **One description template** (`domain/describe.js`), one button catalogue (`lib/buttons.js`), one copy helper (`lib/copy.js`), one rights module (`lib/authz.js`) and one set of limits (`lib/rateLimit.js`).
- **Tenant isolation** on every query; row locks and optimistic locking on writes.

## Owner decisions (2026-10-25)
Answers given by the owner are marked **(owner)**. Everything else is the recommended default, which the owner accepted ("keep the defaults if I didn't pick").

**Q1 Who sees which leads**
- A broker sees the leads assigned to them. Managers (admin, owner, manager) see every lead in the agency.
- Unassigned leads are visible to managers only.
- A lead a broker captures is assigned to that broker.
- On reassignment the previous broker loses access. Their events stay in the timeline under their name.

**Q2 Lead notifications and duplicates (owner, round 2)**
- **Whoever adds a lead (a manager or a broker), no other broker is notified, and the managers always are.**
- A manager who adds a lead and assigns it to a broker: the assigned broker gets the lead card (that's the point of assigning), the managers get the alert, nobody else hears about it. *Assumed; the owner hasn't contradicted it.*
- A duplicate (the phone already belongs to a colleague's lead): the owning broker is **not** messaged; the managers get one alert with both names and decide (reassign or leave); the capturing broker is told "the client is already registered with a colleague; your manager has been told".

**Q3 Assigning imported leads**
- The CSV's "assigned broker" column is used when it's present. Rows without it stay unassigned.
- The preview has a round-robin tick box.

**Q4 Stages**
- The stages are new, contacted, interested, viewing, negotiation, won ✅ and lost ❌.
- Marking a lead lost needs a reason.
- Any stage can move to any other, and every move is logged.

**Q5 Follow-ups**
- One open follow-up per lead.
- A date with no time means 10:00 Cairo time.
- Quick choices: tomorrow, in 3 days, next week, or a typed date and time.
- A lead with no contact for 24 hours gets one nudge.
- Quiet hours run from 22:00 to 08:00 Cairo time.
- Reminders are grouped into one per broker per sweep. They're delivered through the notification centre (step 2).

**Q6 Match alerts**
- Strict matches only. The broker is alerted within about a minute, once per unit per request.
- At most 10 alerts a day per broker.
- The client is never messaged automatically.

**Q7 Lawful basis**
- Every lead records one of `client_request`, `consent` or `existing_client`.
- A CSV import needs an "these clients asked to be contacted" tick.
- The agency supplies its own privacy note.

**Q8 Retention**
- A lead is erased after 18 months with no activity. A manager sees a warning 30 days before.
- Deals are kept, but the client's name and phone are removed.
- Stored inbound WhatsApp payloads are cleared after 7 days.

**Q9 Export and erase**
- Managers only.
- Export gives a zip with `.json` and a readable `.txt`.
- Erase is a hard delete. A keyed hash of the phone is kept, so a later re-capture shows "this client asked to be deleted".

**Q10 Commission (owner)**
- Commission **is negotiated per deal**, so there are no agency default rates.
- The broker enters it on each deal, on WhatsApp or the website, as an amount or a percentage of the price.
- Optional splits: an external co-broker share, and shares between colleagues. The shares must add up exactly, the amounts are whole EGP, and the remainder goes to the closing broker.
- A manager can correct a deal.
- A broker sees their own deals and their share. Managers see all deals and the monthly totals.

**Q11 CSV and Excel columns**
- The columns are name, phone (required), second phone, type of lead, source, budget, area or compound, property type, bedrooms, sale or rent, notes, stage, assigned broker and lawful basis.
- Headers can be in Arabic or English.
- Files can be `.csv` or `.xlsx`, up to 5 MB and 2,000 rows.

**Q12 Sources (owner)**
- **Any text is accepted.**
- The picker shows a common list plus **"Other / أخرى"** with a free-text box: واتساب/WhatsApp, فيسبوك/Facebook, أوليكس-دوبيزل/OLX-Dubizzle, بروبرتي فايندر/Property Finder, ترشيح/Referral, زيارة المكتب/Walk-in, مكالمة/Call, أخرى/Other.
- Unknown values from CSV or AI are kept as typed.

**Q13 Commands (owner)**
- **Every command has an English form**, and the help menu and guides show both:

| Arabic | English |
| --- | --- |
| «ليد» / «عميل جديد» | `lead` / `new lead` |
| «عملائي» | `my leads` / `leads` |
| «متابعات» | `followups` |
| «طلب …» | `request …` |
| «صفقة …» | `deal …` |
| «حول … لـ …» | `assign … to …` |
| «L-0042» | `L-0042` |

- A unit-tests table pins every pair.
- `عميل CODE` / `client CODE` (the client copy) stays unchanged.

**Q14 The `[Call][WhatsApp]` card**
- WhatsApp reply buttons can't dial a number or open a link. So the card body carries the tappable phone number and a `wa.me` link with a greeting prefilled.
- The card's three buttons log what happened: **[📞 Called / كلمته] [📅 Follow-up / متابعة] [🔄 Stage / المرحلة]**.
- The website card has real Call and WhatsApp buttons.
- Through the notification centre, a web push opens the lead page, where both buttons are real.

**Q15 Notification channels, credits and limits (owner, rounds 2–4)**
- **WhatsApp first, website after the limit.** Every notification goes on WhatsApp while the agency has message credits left and the broker's 24-hour window is open. When the credits run out, or the window is closed, it goes to the website (web push and inbox).
- **One notification, one channel. Never both** (it would feel like spam). It goes on the chosen channel; the other channel is used only when that delivery fails (no credits, window closed, not accepted). The website inbox lists every notification **silently** (no sound, no push), so nothing is lost and nothing is doubled.
- **No repeats:** each event can notify a broker once (a unique key per event and broker), even with retries or two servers; several alerts in a short time are merged into one message.
- **Controls:**
  - Each broker, in `/app/settings`: per notification type (assignment, follow-up, match, client opened a link, hot client, manager alerts), choose WhatsApp or website; quiet hours.
  - Managers, in agency settings: the monthly credits, live usage, and an optional per-broker daily or weekly cap (off by default), so one person can't use up the agency's credits.
  - **Notification log (managers):** every alert, who got it, on which channel, why (chosen, fallback, no credits, window closed) and whether it was delivered. Runbook SQL for the same.
- **Message credits (what brokers see):** 1 credit = 1 WhatsApp message the bot sends; everything that costs counts (replies and notifications). Free things never count: everything on the website, web push, read ticks ("seen") and the typing indicator. A marketing template, if ever used, would count about 18 credits. We also track the cost in EGP, internally only.
- **Pools:** in the POC all agencies share our one number, so Meta's 1,000 free messages a month are one shared credit for us, and a **global monthly ceiling** caps our total cost. An agency with its own number gets its own pool later.
- **Starting numbers (database per agency, server-setting defaults):**

| Setting | POC value |
| --- | --- |
| Credits per agency per month | **4,000** (5 typical brokers ≈ 3,850) |
| Warning to managers | 80% |
| At 100% | notifications move to the website; replies continue |
| Hard ceiling | 110%: then each broker gets **one** notice a day ("monthly limit reached; do it on the website: <link>", about 0.21 EGP), and after that their messages only get read ticks (free); the website inbox explains why |
| Global ceiling (all agencies on our number) | 8,000 a month |
| Sign-in links | not counted in the credits; their own ceiling of 200 a month per agency plus the existing 6 an hour per broker |
| AI calls | lowered to 300 a day per agency for the POC (typical use is about 75) |

- **Tracking usage:**
  - Website, "My usage / استهلاكي" (free): my credits today and this month by action (search, add unit, flyer, client copy, CRM), the agency's remaining credits; managers also see each broker.
  - A one-line hint added to a reply the bot is already sending, once at 50%, 80% and 100% (free: no extra message).
  - «رصيدي» / `usage` on WhatsApp: a short answer with the link (1 credit).
- **Before the switch:** at 100% each broker gets one last WhatsApp message: "Alerts now come on the website; turn on notifications and add it to your home screen: <link>". Onboarding covers both from day one.
- **Sign-in** stays on WhatsApp, even after the credits run out (with its own ceiling). Website-only sign-in (a passkey) comes later.

## Channel strategy and Telegram assessment

### What WhatsApp costs now (checked on 2026-10-25)
- Since **1 October 2026**, Meta bills **service messages**: the bot's replies inside the 24-hour window. The first **1,000 per business number per month** are free. The free-entry-point window is unchanged.
- **Egypt rates per message**, before 14% VAT:
  - service and utility: about **$0.0036**, roughly 0.18–0.21 EGP with VAT
  - marketing: about **$0.064**
- Sources disagreed until mid-October, while Meta's own pages lagged. **Check the invoice of the first billed month.**
- Sources:
  - [respond.io: WhatsApp pricing change 2026](https://respond.io/blog/whatsapp-pricing-change-2026)
  - [wawcd: service message pricing changes on 1 October 2026](https://wawcd.com/blog/whatsapp-pricing-change-october-2026)
  - [gradezilla: October 2026 changes](https://gradezilla.org/whatsapp-business-api-pricing/)
  - [nonito: Egypt rates](https://www.nonito.io/whatsapp-business-api-pricing/egypt)
  - [chatmaxima: Egypt rates](https://chatmaxima.com/whatsapp-api-pricing/egypt/)

The **1,000 free messages are per phone number, not per agency.** A 5-broker agency uses about 3,850 messages a month (usage per action below):

| Setup | WhatsApp cost a month | Share of revenue (1,500–2,000 EGP per agency) |
| --- | --- | --- |
| Pilot (1 agency, 1 number, everything on WhatsApp) | about 600 EGP | about 30–40% |
| 10 agencies sharing **one** number | about 7,900 EGP (≈ 790 per agency) | about 40–50% |
| 10 agencies, **one number each** | about 600 EGP each | about 30–40% |
| Any of the above with the website doing the browsing and alerts after the credits | lower; the pilot measures how much | |

**Risk, in order:**
1. **Margin.** Every reply now costs money. A chatty broker costs more than a quiet one, and the plan's price doesn't scale with use.
2. **A single number is a single point of failure.** A quality-rating drop or a ban stops every agency at once.
3. **Meta policy.** Since 15 January 2026 Meta bars general-purpose AI assistants from the Business API. AqarChat is a business tool whose AI is ancillary (listings, search, CRM), which Meta says stays allowed ([TechCrunch](https://techcrunch.com/2025/10/18/whatssapp-changes-its-terms-to-bar-general-purpose-chatbots-from-its-platform), [9to5mac](https://9to5mac.com/2025/10/20/whatsapp-bans-ai-chatbots-from-using-its-business-api/)). The small-talk guard (B2) keeps the bot from acting as a general chatbot, and it must stay.

### Telegram: is moving necessary now?
**No: not as a replacement, and not for the pilot. But Release 3 makes it cheap to add as a second channel.**

| | WhatsApp | Telegram |
| --- | --- | --- |
| Cost per message | about 0.2 EGP after 1,000 a month per number | free |
| 24-hour window and templates | yes | none |
| Buttons | 3 reply buttons, or 1 link button | inline keyboards with many buttons, URL buttons, editable messages |
| Ban risk | per number; quality rating | bot tokens rarely banned; low |
| **Where Egyptian brokers work** | **everything: clients, groups, forwards** | used by some, rarely for clients |
| Intake of client chats and group posts | forward inside the same app | must share across apps (copy, or the share sheet) |

The core habit the product is built on is "forward it to the bot". It only works inside WhatsApp. Moving would remove the main reason brokers use AqarChat. The cost is controlled instead with message credits, the website for heavy tasks, and alerts that move to the website when credits run out.

**What Release 3 does instead:**
1. **The notification centre and message credits** (step 2): alerts go on WhatsApp while the agency has credits, then on the website for free; brokers choose the channel per alert; usage is visible to everyone.
2. **A channel layer** (step 2) puts outbound alerts and replies behind `lib/channels/` (`whatsapp`, `webpush`, and a `telegram` stub with a contract test). Inbound messages already have one shape (`handleInboundMessage`). That means a Telegram adapter is about 2–3 days of work later, not a rewrite.
3. **Measurement:** the runbook gets a monthly cost-per-agency query (`wa_outbound` × rate) and a 10% revenue alarm.
4. **Revisit Telegram, or one number per agency, when any of these happens:**
   - WhatsApp cost goes above 10% of an agency's revenue for two months
   - the number's quality rating drops to "low", or the number is restricted
   - Meta raises service pricing again
   - an agency asks for Telegram
   - Then the recommended order is: first **one number per agency** (each gets its own 1,000 free, and the bot speaks with the agency's name); then **Telegram as an opt-in channel for heavy users**, with WhatsApp kept for intake.
5. **A backup number** is registered and kept warm. The runbook adds the switch-over steps.

### The website as a full backup (owner, round 2)
If WhatsApp prices spike, WhatsApp could be dropped, so everything a broker does on WhatsApp must also work on the website:
- Already there: search, add and edit units (with voice), quick updates and bulk edit, client copy and share links, imports and exports, the CRM pages of this release.
- Added in Release 3: the flyer as a download from the unit page; lead intake by paste; on Android, the installed site appears in WhatsApp's **Share** menu ("Share to AqarChat", the web share target), so forwarding a client message or contact card still works; iPhone users get a paste box (iPhone doesn't allow share targets).
- A parity test lists every WhatsApp command and the website page that does the same.
- The remaining gap is sign-in, which needs WhatsApp until a passkey (fingerprint or face) sign-in is added (later; about a day of work).
- **Telegram and a React Native app** stay future options: both would be adapters on the same services and channel layer, with nothing built for them now beyond the Telegram stub.

### WhatsApp usage per action (from the current code)
| Action | WhatsApp credits | AI calls |
| --- | --- | --- |
| Search (text / voice) | 1 (+1 per "more") | 1 / 2 |
| Add a unit: open, details, review, save | 4–5 | 1 (+1 per voice note) |
| 📸 reaction on each photo (today) | 1 per photo (≈ 8 a unit) | 0 |
| Flyer | 1 | 1 the first time per unit, 0 after |
| Client copy + link | 1 | 0 |
| Quick update | 1 | 0 (voice: 1) |
| Edit | 3 | 1 |
| CRM: save a lead (confirm + saved) | 2 | 0–1 (voice: 2) |
| CRM: button tap or notification | 1 each | 0 |
| Sign-in link | 1 (about once a month) | 0 |

Per broker per working day: light ≈ 20 credits (≈ 440 a month), typical ≈ 35 (≈ 770), heavy ≈ 55 (≈ 1,200). An agency with 5 typical brokers ≈ 3,850 a month, about 600 EGP of WhatsApp after the shared 1,000 free. **Pricing implication:** later plans should include credits per broker (for example 700) plus extra packs.

**Fix P11 (step 2):** the per-photo 📸 reaction is probably billed like a message, which makes it the biggest hidden cost. It is removed; the next reply says "📸 8 photos received" instead.

## Product review (senior PM, whole product)

### Bugs and risks found
| ID | Finding | Fix in Release 3 |
| --- | --- | --- |
| P1 | Two phone normalizers (`lib/util.js` `normalizePhone`, `lib/onboarding.js` `normalizeEgyptMobile`); lead dedupe depends on one rule | one `domain/phone.js`, step 1 |
| P2 | `inbound_messages.payload` keeps every forwarded client text and contact card forever (PDPL) | purge after 7 days, step 10 |
| P3 | Nothing stops lead names or phones from reaching `operation_logs` or log lines | a sentinel test over all CRM flows, step 10 |
| P4 | The cost model in the docs is out of date (Meta pricing changed on 1 Oct 2026); share-link "opened" alerts are WhatsApp sends | runbook update; alerts move to the notification centre, step 2 |
| P5 | There's no scheduler, so nothing can happen unless a broker sends a message (follow-ups, alerts, retention, and the Release 4 auto-hide) | `lib/scheduler.js`, step 1 |
| P6 | Deactivating a broker leaves their leads, requests and deals with nobody; their units too | on deactivation, managers get "N leads to reassign" and the leads go to the unassigned pool, step 3 |
| P7 | The web app has no language switch (only `lang en` on WhatsApp), and the sign-in page is Arabic only before sign-in | language switch in the top bar and on the sign-in pages, step 11 |
| P8 | Onboarding: guides and the welcome message are Arabic only; brokers must message the bot first or the bot can't reply, which is a common pilot failure | English guides, plus a per-broker `wa.me/<bot>?text=help` "start" link printed by `onboard`, step 11 |
| P9 | Coverage gaps: crash recovery (SEC-03 `bootRecovery`), the WhatsApp Excel upload (XLS-01…04) and STATS-01 have no tests | tests added in step 12 (stabilisation), no behaviour change |
| P10 | Single WhatsApp number = single point of failure | backup number and runbook steps (channel strategy) |
| P11 | A 📸 reaction is sent for every photo, each probably billed like a message (≈ 8 a unit) | no per-photo reaction; the next reply counts the photos, step 2 |
| P12 | The AI quota (2,000 calls a day per agency) allows up to about 3,000 EGP a month in the worst case | POC default 300 a day per agency, step 2 |

### Missed core CRM features (added to the steps)
- **Seller and landlord leads.** In Egypt, half of a broker's leads are owners who want to sell or rent out. Leads get `kind` buyer|tenant|seller|landlord. A seller lead offers "➕ add their unit", which opens the draft with the owner's name and phone filled in as internal fields (step 3).
- **Reassignment when a broker leaves** (P6).
- **A history of units shown to the client.** Every "send to client" share link carries `lead_id`, so the lead page lists what was sent and what the client opened (step 7).
- **A light viewing appointment.** A follow-up can be marked "viewing", with a unit code and a time. The reminder carries the unit line and its location (step 8). A full viewing scheduler stays deferred.
- **A manager pipeline view.** The web leads page shows counts per stage and overdue follow-ups per broker (step 5). The full dashboard stays in Release 4.

### Wow features for Release 3 (cheap, high impact)
1. **"🔥 3 clients want this unit".** When a broker saves a unit, the save confirmation they already get says how many open client requests the unit fits: "🔥 3 clients want this unit: 1 yours, 2 with colleagues" with [See my client] [Send to client]. The broker sees details only for their own clients and **no colleague names**. **Managers** get it with names ("VIL-08 fits 3 clients: Sara (1), Omar (2)"), grouped with their other alerts; a manager who saves the unit sees the names in the save reply. Colleagues whose clients match get their normal match alert. No extra message for the saver and no AI call: it uses the same match SQL (step 7).
2. **Zero results become a request.** "مفيش نتائج" / "No results" gets a button: **"🔔 Save as client request / سجل طلب للعميل"**. The broker types or forwards the client's number; AqarChat shows what it understood and saves only after **[✅ Confirm]** (rule below), then alerts when a matching unit arrives. This turns a dead end into a lead (step 7).
3. **One voice note updates the CRM.** «كلمت أحمد، عايز يعاين VIL-08 يوم الجمعة الساعة ٥» / "Called Ahmed, he wants to view VIL-08 Friday at 5" becomes:
   - marked contacted
   - stage moved to viewing
   - a Friday 17:00 viewing follow-up with the unit attached
   - a one-message confirmation with an undo button

   It costs two AI calls: transcription and one `lead_update` extraction (step 9).
4. **Who is calling?** Send or forward any phone number, or a contact card that's already a lead, and get the client's card and history at once. Brokers do this while the phone rings. It needs no AI (step 4).
5. **The hot-client signal.** A client who opens a sent unit link 3 or more times in 48 hours is marked 🔥. The broker gets one alert ("أحمد فتح VIL-08 ٣ مرات") with a follow-up button. It uses the share-link opens that already exist (step 7).
6. **No lead left without a next step.** After any contact, if the lead has no follow-up, AqarChat suggests one with one tap (default: in 2 days). The lead list's "no next step" filter shows the rest (step 8).

## UX review (dead ends, easier choices, data types and quantities)

### Rules for every CRM surface
- **No dead ends.** Every message ends with a next action: buttons, or a short typed hint. Every error says what to do next. Every list that is cut off ends with "see all on the website: <link>".
- **Buttons don't depend on a session.** They carry the lead reference (`L-0042`), and every tap reloads the lead and checks rights. An old button still works days later, or says plainly why it can't ("the lead was reassigned"). That avoids the "session expired" dead end.
- **Confirm what the AI understood (owner, round 2).** Anything read by the AI from a voice note or free text (a lead, a client request, a voice CRM update, a no-results request) is shown first as "I understood: …" with **[✅ Confirm] [✏️ Edit] [❌ Cancel]**, and nothing is saved until Confirm. Inputs with no AI (a contact card, a typed number, a CSV, button taps) save directly with Undo.
- **Undo instead of confirm** for reversible actions with no AI (stage, contacted, follow-up): the confirmation message has **↩️ Undo / تراجع**, valid for 10 minutes. Only irreversible actions confirm first: erase (type the last 4 digits) and recording a deal (review card).
- **Bilingual everywhere:** the broker's language for copy, any language for input. Mixed Arabic and English names, Arabic digits and English commands all work.

### Data types handled at intake
| Input | Handling |
| --- | --- |
| Contact card with several numbers | Saved under all of them (main + second). Dedupe checks every number. |
| Forward with two or more phone numbers | "Which one is the client?" list (up to 10). Never a guess. |
| Forward or voice with **no** phone | Saved as a draft lead: "ابعت رقم العميل / Send the client's number" (30 minutes). The name and request are kept, so nothing is lost. |
| Phone numbers spoken in Arabic words in a voice note ("صفر واحد صفر…") | The AI returns digits, then `domain/phone.js` checks them. An invalid number asks the broker to confirm. |
| Landlines, international numbers, numbers with spaces, dashes or `+`, Arabic digits | normalized; landlines are accepted (no WhatsApp link shown) |
| No name | Shown as "Client ••5678 / عميل ••5678". Never invented. |
| Budget as "٩ مليون", "9M", "9,000,000", "من 7 لـ 9", "قسط 50 ألف", "إيجار 25 ألف" | the existing price parser and the canonical filters (price range, max installment, rent) |
| Several areas ("التجمع أو زايد") | One request with several places (the filters already hold a list). |
| A forwarded **unit** post or a unit code | still goes to the listing flow, never to a lead |

### Quantities
| Scale | Handling |
| --- | --- |
| WhatsApp lists | at most 5 items, then the count and a web link (leads, follow-ups, matches) |
| Grouped reminders and alerts | 5 lines, then "and N more" with a link |
| Web lists | pages of 20, search by name, phone or `L-` reference; filters for stage, kind, source, broker (managers), "no next step" and overdue |
| CSV of 2,000 rows | The preview shows the counts per kind and the first 50 rows of each kind (download the full preview as `.xlsx`). The apply step runs **in the background with a progress bar** (htmx polling, like the group import), because 2,000 transactions don't fit one request. |
| A lead with hundreds of events | The timeline shows the last 20, then "older". |
| An agency with thousands of leads | indexed lists; the match sweep is limited per tick; retention runs in batches of 500 |

### Web
- **Mobile first.** The lead page has a fixed bottom bar: **Call · WhatsApp · Follow-up · Stage**.
- **Empty states** come with a first action ("No leads yet: forward a client's message to the bot, or add one here").
- **Push opt-in** is asked after the first useful moment (the first lead saved), not on page load. The prompt explains why and gives iPhone add-to-home-screen steps.

## Lead field rules
| Field | Rule |
| --- | --- |
| Phone | **Mandatory.** E.164 through `domain/phone.js`. Unique per agency (the dedupe key). Up to 3 numbers per lead, each checked for duplicates. |
| Kind | buyer (default), tenant, seller, landlord |
| Name | optional; never invented |
| Source, lawful basis | set by the intake channel; CSV from its columns or the confirmation tick |
| Request | optional; canonical search filters on a `saved_searches` row with `lead_id` (buyer and tenant leads) |
| Stage | `new` on create |
| Notes | internal; never in a client copy or a public page |

## Release 3 steps (build after approval)

### 0. Branch and plan
This plan on `poc/release-3`, revised with the owner's answers and the reviews.
- **Migration `010_lock_public_api.sql`** (Phase A, 2026-10-25): Supabase's advisor showed `anon` could read every public table through the Data API, including `web_sessions` and `web_login_tokens`. RLS is now on everywhere and the API roles have no grants, also by default for new tables. Every Release 3 table must keep RLS on (`tests/unit/public-api-lockdown.test.js` fails otherwise).

### 1. Foundation: phone, scheduler, settings
- `domain/phone.js`: `normalizePhone`, `isEgyptMobile`, `isLandline`, `displayPhone`, `waMeUrl`, `last4`. `lib/util.js` and `lib/onboarding.js` delegate to it (**P1**).
- `lib/scheduler.js` (**P5**): a 60-second tick in each instance. Each job runs under `pg_try_advisory_lock`, so one instance runs it. It's off under tests, where `tick({ now })` is called with a fixed clock. Every job writes `crm_job_<name>` telemetry (counts only). It starts after the port binds and stops first on drain.
  - Env: `SCHEDULER_ENABLED`, `SCHEDULER_TICK_MS`.
- **Migration `011_crm_settings.sql`:** `agencies.crm_settings jsonb` (privacy note, quiet hours) and `crm_jobs` (job watermarks).
- **Tests:**
  - 25+ phone cases (Arabic digits, `+20`, `0020`, landlines, foreign numbers, junk)
  - existing broker lookups unchanged
  - two concurrent ticks run each job once
  - a failing job doesn't stop the others

### 2. Notification centre, channel layer and message credits (Q15)
- **Migration `012_notifications.sql`:**
  - `notifications`: `id`, `agency_id`, `broker_id`, `kind`, `dedupe_key` (unique per broker), `title`, `body`, `url` (a relative `/app/…` path), `lead_id`/`listing_id` (nullable), `created_at`, `read_at`, `channel` (whatsapp|webpush|inbox), `reason` (chosen|fallback|no_credits|window_closed), `status` (sent|failed|skipped)
  - `push_subscriptions`: `broker_id`, `agency_id`, `endpoint` (unique), `p256dh`, `auth`, `user_agent`, `created_at`, `last_ok_at`, `failed_count`
  - `brokers.notify_prefs jsonb` (per kind: whatsapp|web; quiet hours; default WhatsApp for every kind)
  - `agencies.wa_credits_monthly`, `agencies.wa_broker_daily_cap`, `agencies.wa_broker_weekly_cap` (nullable = server default / off)
- **Credits (`lib/credits.js`), like the AI quota:** `check(pool, broker, { kind })` reads this month's `wa_outbound` rows for the agency (and the broker's day or week when a cap is on) and the global ceiling; returns `{ allowed, level: ok|warn|limit|ceiling, remaining }`. `dispatcher.deliver` asks it before every send, so every paid message counts (replies and notifications); sign-in links use their own ceiling. Each `wa_outbound` row also stores the price in EGP (config `WA_PRICE_EGP`), for us only.
  - Limit (100%): notifications go to the website; replies continue.
  - Ceiling (110%): one notice a day per broker with the website link, then read ticks only (`markAsRead`, free).
  - The 50/80/100% hint is appended once to a reply already being sent.
- **`lib/notifications.js` `notifyBroker(pool, broker, { kind, dedupeKey, title, body, url, leadId, listingId })`:**
  1. Insert the inbox row with `ON CONFLICT (broker_id, dedupe_key) DO NOTHING`; if it already existed, stop (no repeats).
  2. Pick **one** channel: the broker's preference for this kind, unless quiet hours (hold), no credits or a closed 24-hour window → website.
  3. Send; if WhatsApp fails, fall back to web push once; record `channel`, `reason`, `status`. Never both.
  4. Telegram is a stub.
  - Alerts of the same kind within 2 minutes are merged into one before sending.
- `lib/channels/{whatsapp,webpush,telegram}.js` share one interface, `send(broker, message) → { ok, id }`, with a contract test. `web-push` is a pinned dependency; VAPID keys are config (`WEB_PUSH_PUBLIC_KEY`, `WEB_PUSH_PRIVATE_KEY`, `WEB_PUSH_SUBJECT`), required in production.
- **Moved onto it:** the share-link "opened" alert (WEB-19).
- **P11:** no per-photo 📸 reaction; the next reply counts the photos. **P12:** `AI_QUOTA_AGENCY_DAILY` set to 300 for the POC.
- **Web:**
  - 🔔 in the top bar with the unread count; `/app/notifications`
  - `/app/settings`: language, per-kind channel, quiet hours, push on/off with a test push
  - `/app/usage`: my usage and the agency's (managers: per broker, caps)
  - managers: the notification log, agency credits and caps
  - the service worker gains `push` and `notificationclick` (opens only `/app/` URLs) and the web share target (`/app/share`); it still never caches pages. *(Built: the share target moves to step 5, where it can save a lead.)*
  - push payloads carry only a title, a short body and the URL; never a phone number
- **Tests:**
  - exactly one delivery per notification in every case (chosen, fallback after a failed WhatsApp send, no credits, closed window, quiet hours); the same event twice → one notification
  - merging within 2 minutes
  - credits: counts every paid send, ignores free ones; warn, limit and ceiling behave as the table says; the daily notice is sent once; per-broker caps; the global ceiling; sign-in links have their own ceiling
  - the usage page numbers equal `operation_logs`
  - photos: no reaction per photo, the count in the next reply
  - push 410 removes the subscription; the share target saves a lead from shared text
  - settings round trip with CSRF; tenant and broker isolation of the inbox and the log
  - no phone number or full name in any push payload

### 3. The leads data model and service
- **Migration `013_leads.sql`:**
  - `leads`:
    - identity: `id`, `agency_id`, `ref` (a per-agency number shown as `L-0042`, unique per agency)
    - kind and ownership: `kind`, `assigned_broker_id`, `created_by_broker_id`
    - contact: `name`, `phone_e164`, `phones text[]` (all numbers), `lang`
    - origin: `source`, `lawful_basis`, `consent_at`, `consent_note`
    - pipeline: `stage`, `lost_reason`, `notes`
    - follow-up: `next_follow_up_at`, `follow_up_kind` (call|viewing), `follow_up_listing_id`, `follow_up_note`, `follow_up_status`
    - activity: `hot_at`, `last_contact_at`, `last_activity_at`, `created_at`, `updated_at`, `version`
    - unique `(agency_id, phone_e164)`, plus a GIN index on `phones` for dedupe across all numbers
  - `lead_events`: append-only, with `kind` in created, inquiry, assigned, stage, note, contacted, follow_up_set, follow_up_done, request_set, match_sent, share_opened, deal, exported, merged and undo
  - `lead_erasures`: a keyed hash under `LEAD_HASH_KEY`
- `domain/leadStages.js`, `domain/leadCard.js` (card, request summary, timeline lines, the "Client ••5678" fallback; both languages).
- `lib/authz.js` gains `canViewLead`, `canEditLead`, `canManageLeads`, `canViewDeal` and `canEditDeal`. It stays the single copy.
- `services/leads.js`:
  - `captureLead` with the **Q2 duplicate rules**: it returns created, merged, colleague or erased_before, and who to notify
  - `assignLead`, `setStage`, `addNote`, `markContacted`, `setFollowUp`, `completeFollowUp`
  - `undo(eventId)`: reverts the last reversible event within 10 minutes
  - `listLeads` (role-scoped in SQL), `getLead`, `findByPhone` (role-scoped), `timeline`
  - `releaseBrokerLeads` (**P6**: on deactivation, the leads go to the unassigned pool and managers get one notification)
- **Tests:**
  - dedupe across 4 spellings and across second numbers
  - the Q2 rules: managers always alerted, no other broker notified, the assignee gets the card, the duplicate owner not messaged
  - role scoping
  - tenant isolation
  - version conflicts
  - stage rules
  - undo inside and after the 10 minutes
  - deactivation releases leads and notifies managers
  - every query scoped by agency (contract test)

### 4. WhatsApp intake, the card, "who is calling?"
- `domain/leadIntake.js` (pure):
  - `findPhones`, `parseContactCard`
  - `looksLikeLead` (a phone, and no unit code or unit shape)
  - `buildLeadPrompt` (fenced input) and `normalizeLeadExtraction` (name, phones, kind, request filters, note; never fills what the AI left empty)
- `lib/leadIntake.js`:
  - **Contact card** (today ING-06 "unsupported"): an existing lead shows its card (**who is calling?**). A new one offers **[➕ Save as client / حفظ كعميل]**. No AI.
  - **A bare phone number** typed or forwarded: an existing lead shows its card; otherwise the same save offer.
  - **«ليد» / `lead` + text, or a voice note that starts with those words:** intake through one `lead_extraction` AI call (new route: 15 s deadline, 5 s hedge), shown as "I understood: …" with **[✅ Confirm] [✏️ Edit] [❌ Cancel]**; saved only on Confirm (2 credits). If the AI is down, the broker is offered to save the phone alone.
  - **«ليد» / `lead` alone** opens a lead draft (30 minutes) that collects the next text, forward or voice note.
  - **A forwarded text with a phone and no unit code:** "Is this a client? / ده عميل؟" **[➕ Save as client] [🔍 Search]**. The text waits server-side (`pending_lead`), never in a button id.
  - Several phones: a "which one is the client?" list. No phone: "send the client's number" (the UX table).
- **The card** (Q14): the phone and the `wa.me` link in the body; **[📞 Called] [📅 Follow-up] [🔄 Stage]**. A seller or landlord lead gets **[➕ Add their unit]** in place of Stage on its first card. That opens the draft with the owner's name and phone filled in as internal fields.
- **Assign:** `assign L-0042 to Sara` / «حول L-0042 لـ سارة» (managers). The assignee is told through the notification centre, and the manager gets a one-line confirmation.
- **Commands:** «عملائي»/`my leads` (top 5 + web link), `L-0042` (the card), «متابعات»/`followups`. The help menu lists both languages.
- **Router tests:**
  - contact card new and existing (0 AI calls)
  - a bare number lookup, including a colleague's lead, which shows nothing beyond the Q2 copy
  - «ليد» + forward (1 AI call)
  - a voice intake equals the text intake
  - several phones → the list; no phone → the prompt and the completion
  - a forwarded unit still goes to the listing flow; `عميل CODE` / `client CODE` is unchanged
  - Q2 duplicates
  - the AI down
  - buttons (including old buttons days later, and undo)
  - the seller lead → add their unit, prefilled
  - English and Arabic forms of every command
  - one message per turn

### 5. Web CRM pages
- `/app/leads`:
  - tabs by stage, plus "due today", "overdue" and "no next step"
  - search by name, phone or `L-` reference
  - filters for kind, source and broker
  - pages of 20
  - managers also get the pipeline counts per stage and the overdue counts per broker
- `/app/leads/new`:
  - the source picker with **Other**
  - lawful basis
  - "✨ Fill from message / املأ من الرسالة" and 🎙️
  - the duplicate notice before saving
- `/app/leads/<ref>`:
  - the card with real Call and WhatsApp buttons in the fixed bottom bar
  - stage, follow-up (call or viewing, with a unit), notes, assign (managers)
  - the timeline (last 20 + older), requests and matches, units sent to the client and their opens, deals
  - writes go through `services/leads.js` with the version the page was opened at (a change made meanwhile is a 409 conflict)
- Rate limits: lead extraction 20 per 10 minutes, writes 120 a minute.
- **Supertest tests:**
  - role scoping by list, URL and phone search
  - create with dedupe
  - stage, follow-up and note round trips
  - a conflict with a WhatsApp tap
  - assignment by a manager
  - the pipeline counts are visible to managers only
  - CSRF
  - tenant isolation
  - `no-store`
  - escaping (`<script>` as a name)
  - English pages

### 6. CSV and Excel lead import
- `domain/leadImport.js`:
  - the Q11 columns in Arabic and English
  - row kinds: new, merge (fills blanks, never overwrites), colleague, invalid (with the reason), erased_before, repeated
- `lib/sheets.js` `readCsv` (in memory; BOM, comma or semicolon, quotes; 5 MB and 2,000 rows).
- `services/leadImports.js`: the existing plan → preview → apply-once flow (**migration `014_lead_imports.sql`** adds `leads` to the `web_imports.kind` check). **The apply step runs in the background with a progress bar.**
- The lawful-basis tick is required. Assignment uses the column, or round-robin when ticked.
- The template is at `/app/leads/import/template.xlsx`.
- **Tests:**
  - Arabic and English headers; CSV with BOM and semicolons; `.xlsx`
  - dedupe within the file and against the database
  - colleague rows are not reassigned
  - erased phones are flagged
  - nothing is written before apply; a second apply is refused (409)
  - the tick is required
  - formula cells stay text
  - round-robin is even
  - a 2,000-row file finishes in the background and reports progress
  - tenant isolation; the upload rate limit

### 7. Buyer requests, match alerts and the wow loop
- **Migration `015_buyer_requests.sql`:**
  - `saved_searches.lead_id`, `alerts_enabled`
  - `lead_matches` (unique per request and unit; status new, alerted, sent_to_client or dismissed)
  - `share_links.lead_id`
- **Requests:**
  - On WhatsApp: «طلب …» / `request …` on the open lead, or inside the intake text.
  - On the web: the refine form on the lead page.
  - Up to 3 requests per lead. Each request can hold several places.
  - The reply shows the summary and the current matches (up to 5) in one message.
- **Match sweep (scheduler):**
  1. Read listings changed since the watermark (every write path, no hooks).
  2. Run each alerting request through `buildSearchQuery` restricted to the changed ids. That's the same SQL as search.
  3. Insert the new `lead_matches` rows.
  4. Send one grouped notification per broker (at most 10 a day).
- **Wow 1:** the saved-unit card (draft confirm and the web save) gains "🔥 N clients want this unit / عملاء عايزين الوحدة دي" with a button to list them. It's computed in the same reply, so it costs no extra message.
- **Wow 2:** the no-results search reply gains **[🔔 Save as client request]**, which asks for the client's number and creates the lead and request.
- **"Send to client / ابعت للعميل":** a share link with `lead_id` → a `wa.me/<client>` link prefilled with the client copy and the unit link → a `match_sent` event.
- **Wow 5:** the hot-client signal. 3 or more opens in 48 hours sets `hot_at` and sends one notification with a follow-up button.
- **Tests:**
  - a request by text equals a request by voice
  - units added by the draft, the web form, an import and a quick update each alert exactly once
  - a price drop into range alerts; a rollback doesn't; a sold unit never alerts
  - the alerts are grouped; the daily cap holds
  - the sweep's ids equal search's ids for the same filters
  - tenant isolation
  - the saved card count is right and private to the agency
  - the no-results button creates a lead and a request
  - the share link has `lead_id`; the public page shows none of the lead's data (sentinels)
  - the hot signal fires once

### 8. Follow-ups and viewings
- **Scheduler job:**
  - due follow-ups outside quiet hours, `FOR UPDATE SKIP LOCKED`
  - one grouped notification per broker (5 lines + "and N more")
  - viewing reminders carry the unit's compact line and its location
  - the 24-hour "no contact" nudge
  - **Wow 6:** after a contact with no follow-up set, the reply offers "📅 In 2 days?" with one tap
- Buttons in WhatsApp reminders, for brokers who opted in: **[✅ Done] [📅 Postpone]**. The same actions sit on the web notification.
- **Tests (fixed clock):**
  - 10:00 default; quiet hours
  - grouping
  - viewing content
  - done and postpone
  - a reassigned lead reminds the new broker
  - two instances → one reminder
  - the "no next step" filter

### 9. The voice CRM update (wow 3)
- When a voice note or text names a lead (a name or `L-` reference that matches the broker's leads, or the last lead card shown) and describes an outcome, a `lead_update` AI call returns a structured update:
  - `contacted`
  - `stage`
  - `follow_up` (time, kind, unit code)
  - `note`
  - `lost_reason`
- `domain/leadUpdate.js` checks it: the unit code must exist in the agency, the time must be in the future, and an unknown name asks which lead.
- The reply is one message listing what will change, with **[✅ Confirm] [✏️ Edit] [❌ Cancel]**; it's applied as one set of events only on Confirm (the AI-read rule).
- It runs only for brokers' own leads, through `canEditLead`.
- The eval set gains 8 lead extraction cases and 8 lead update cases (Egyptian Arabic, Arabic-English mix, spoken numbers, relative days such as "بكرة" and "الجمعة الجاية").
- **Tests:**
  - the fake-AI update applies every field
  - an ambiguous name → a list
  - a past time → asks again
  - a colleague's lead → refused
  - nothing is written before Confirm; Cancel writes nothing
  - the AI down → "couldn't read it, use the buttons"

### 10. Deals and commission (Q10: negotiated per deal)
- **Migration `016_deals.sql`:**
  - `deals`: lead, listing, closing broker, sale or rent, price, `commission_mode` (amount|pct), `commission_pct`, `commission_total`, external co-broker share, status (pending → signed → paid, or cancelled), client name and phone (cleared on erasure), notes, `version`
  - `deal_splits`: the shares add up exactly
  - an agency check on `lead_id` and `listing_id`
- `domain/commission.js`: total from the amount or percentage the broker typed; the external share off the top; colleague splits in whole EGP, the remainder to the closing broker; validation. At least 10 reference cases.
- `services/deals.js`:
  - `createDeal`: marks the lead won and, when ticked, the unit sold through `applyListingPatch` in the same transaction; a conflict refuses the whole deal
  - `updateDeal` (managers correct)
  - `listDeals`, `monthlyTotals` (role-scoped)
- **WhatsApp:** «صفقة L-0042 VIL-08 8.5 مليون عمولة 2%» / `deal L-0042 VIL-08 8.5M commission 2%` → a review card → **[Confirm ✅] [Edit ✏️] [Cancel ❌]**. A missing commission asks for it (amount or %).
- **Web:** `/app/deals` and "🤝 Record deal" on the lead page.
- **Tests:**
  - the reference cases
  - unit sold and lead won together; a conflict refuses
  - visibility per role
  - a double tap saves once
  - English and Arabic commands
  - commission never appears in any client copy

### 11. PDPL, bilingual pass and onboarding
- **PDPL** (`services/privacy.js`):
  - `exportLead` (managers; a zip, `no-store`, 10 an hour)
  - `eraseLead` (managers; typed confirmation of the last 4 digits; hash kept; deals stripped of the client's data; all CRM rows deleted)
  - `retentionSweep` (daily, in batches)
  - `purgeInboundPayloads`: `payload = '{"purged":true}'` after 7 days for completed and failed rows (**P2**)
  - `LEAD_HASH_KEY` is required in production
- **Bilingual pass (P7):**
  - a language switch in the web top bar and on the sign-in pages (`?lang=`, remembered in a cookie before sign-in, `preferred_lang` after)
  - every new page and message in both languages
  - a test renders every `/app/` page in both languages and fails on a missing key
  - the flyer stays English only
- **Onboarding (P8):**
  - `onboard` prints, per broker, a **start link** `wa.me/<bot number>?text=help` (or `مساعدة` for Arabic brokers), which solves "message the bot first"
  - English versions of the guides: `docs/pilot/broker-howto-en.md` and `docs/pilot/web-howto-en.md`
  - the welcome copy follows each broker's language
  - `agency.example.json` documents `lang`
- **Tests:**
  - export contents (nothing about other people)
  - erase removes every CRM row; the deal survives without client fields; a re-capture warns
  - retention with a fixed clock
  - the payload purge spares recent and pending rows, and `bootRecovery` still works
  - 403 for non-managers
  - **P3:** no sentinel phone or name in any `operation_logs` row, log line, push payload or `wa_outbound` metadata after the full flow
  - the language switch
  - onboarding start links

### 12. Stabilisation and docs
- Tests for the coverage gaps (**P9**): `bootRecovery` replays only `new|batched`, the WhatsApp Excel upload (XLS-01…04), STATS-01.
- **`docs/pilot/crm-howto-ar.md` and `docs/pilot/crm-howto-en.md`.** They cover:
  - saving a client: forward, contact card, «ليد»/`lead`, voice, CSV
  - "who is calling?"
  - the card and its buttons
  - stages, follow-ups and viewings
  - the one voice note update
  - requests, "🔥 clients want this unit" and "send to client"
  - notifications and enabling push (with iPhone steps), and choosing WhatsApp or website per notification
  - **"How WhatsApp credits work"**: 1 bot reply = 1 credit from the agency's monthly balance (search 1, client copy 1, flyer 1, adding a unit ≈ 5, saving a lead 2); free: everything on the website, website notifications, read ticks; where to see usage; what happens at 100% and at the ceiling. The page and the guide read the agency's real numbers from the database.
  - **"Do these on the website (free)"**:

    | Task | On WhatsApp | On the website |
    | --- | --- | --- |
    | Browsing many search results ("more" again and again) | 1 credit per page of 5 | all results, 20 a page, free |
    | Adding a unit with many details or a back-and-forth | about 5 credits | the form, free |
    | Editing several fields, or several units | 3 credits each | edit and bulk edit, free |
    | Many client copies or links | 1 credit each | share button, free |
    | Excel import/export, group posts import | heavy | free |
    | Reviewing leads, follow-ups, pipeline | 1 credit per list | free |
    | Checking many units' status | 1 credit each | units list, free |

    Fine on WhatsApp: one quick search, a quick update, one client copy, forwarding a client, a voice note. Tip: send the details in one message, not five.
  - deals and commission
  - who sees what
  - a client deletion request
  - do's and don'ts for client data

  The broker and web guides link to them, and `docs.test.js` checks they exist.
- **`docs/runbook.md`:**
  - the new env vars: `SCHEDULER_*`, `LEAD_RETENTION_MONTHS`, `INBOUND_PAYLOAD_DAYS`, `LEAD_HASH_KEY`, `WEB_PUSH_*`, `WA_CREDITS_MONTHLY` (4000), `WA_CREDITS_CEILING_PCT` (110), `WA_GLOBAL_MONTHLY_CEILING` (8000), `WA_LOGIN_MONTHLY_CEILING` (200), `WA_PRICE_EGP` (secrets in `render.yaml` as `sync: false`)
  - the scheduler
  - handling an export or deletion request
  - `crm_settings`
  - the new `operation_logs` types and notification kinds
  - **the WhatsApp cost query per agency per month, with the 10% alarm**; setting an agency's credits and caps; reading the notification log
  - the backup number switch-over
  - VAPID key generation and rotation (rotating forces brokers to re-enable push)
  - `LEAD_HASH_KEY` rotation (it weakens the warning for earlier erasures)
- **Meta message templates must be submitted now** for Release 4 (runbook §9):
  - the morning brief
  - "still available?"
  - **utility** templates for the follow-up reminder and the match alert, for brokers who choose WhatsApp
  - approval takes days
- `ARCHITECTURE_MANIFEST.md` §7.G "CRM" and §7.H "Notifications and channels"; `FEATURE_REGISTRY.md` sections for CRM and NTF, coverage rows and the IDs P1–P10.
- Run `/security-review` on the branch diff before the merge.

## Tests that stay green
- The whole existing suite, plus:
  - router: `leads`, `lead-voice`, `deals`
  - web: `leads`, `lead-import`, `deals`, `privacy`, `notifications`, `usage`, `share-target`, `i18n`, `parity` (every WhatsApp command has a website page)
  - unit: `phone`, `lead-domain`, `lead-update`, `commission`, `scheduler`, `channels`, `credits`
- The harness gains `insertLead`, a fixed-clock `tick`, a `contacts` payload builder and a fake web push endpoint.
- Contract guard, schema reference and docs tests run in every commit.

## Cost notes
- **WhatsApp:** every broker action is answered in one reply where it can be (credits per action: see the table in the channel strategy). Notifications go on WhatsApp while credits last, then on the website (free). Prices since 1 Oct 2026: service and utility ≈ 0.21 EGP with VAT; marketing ≈ 3.6 EGP (not used).
- **POC estimate per month (one agency, 5 typical brokers):**

| Item | Estimate |
| --- | --- |
| WhatsApp (≈ 3,850 credits − 1,000 free; capped at 4,400 + 200 sign-ins) | ≈ 600 EGP, at most ≈ 750 |
| Over-limit daily notices | ≤ 30 EGP |
| AI (≈ 75 calls a day; cap 300) | ≈ 85 EGP, at most ≈ 450 |
| Render Starter | ≈ 350 EGP (the pilot runs on Free until after the POC; see below) |
| **Total** | **≈ 1,050 EGP (at most ≈ 1,600)** |

  Prices and the exchange rate (≈ 50 EGP/USD) are checked against the first invoice. The photo-reaction fix (P11) is already counted.
- **AI calls:** 0 for a contact card, phone lookup, CSV, buttons, matches, reminders, the hot signal and "N clients want this"; 1 for a forwarded-text intake or a typed CRM update; 2 for voice; each under $0.001.
- **Web push** is free. **Database:** the match sweep is one indexed query per alerting request per tick, with a limit; memory doesn't change.

**Render plan (owner, 2026-10-25): the service stays on Free until after the POC.** Risks that come with it:
- It sleeps after about 15 minutes idle. The first webhook or page load after that waits 30–60 s (Meta retries the webhook). The owner accepts the slow start.
- `lib/scheduler.js` runs inside the process, so reminders, follow-ups, match sweeps and the retention purge run only while it is awake. On wake the scheduler must catch up from its `crm_jobs` watermarks: a job that is due runs late, never twice and never skipped. Step 1 tests this.
- The service was not created from `render.yaml`. It builds with `npm install`, has no `/health` check and runs Node 26 instead of 22. Moving to Starter means creating it from the blueprint (or copying those settings).

## Security review (done in step 12; recorded in the manifest)
- **Access:** lead, deal, request, match and notification reads go only through role-scoped services. A grep test refuses direct queries from routes. A lead the broker can't see answers 404; the Q2 copy is the one deliberate exception (a colleague's name, no details).
- **Tenant isolation:** the contract test covers the new tables; triggers stop references across agencies.
- **Injection:** CSV and Excel cells are sanitised; HTML is escaped; AI prompts are fenced; button ids carry only `L-` references.
- **PDPL:**
  - lawful basis on every lead
  - access by role
  - export and erase with an audit row
  - retention
  - the payload purge (P2)
  - no personal data in telemetry, logs or push payloads (P3)
  - none on public pages (sentinel test)
  - exports never cached
- **Push:** the subscription is tied to the signed-in broker; revoked when the broker is deactivated or signs out everywhere; payloads minimal; clicks open only `/app/` URLs.
- **Abuse:** rate limits on AI intake, writes, imports and exports; daily caps on alerts; pending state server-side only.
- **Secrets:** `LEAD_HASH_KEY` and the VAPID keys are required in production (fail-fast).

## AI test budget (owner, 2026-10-25)
- The Gemini key is pay-as-you-go with a $5 balance. **Live testing may spend at most $2 in total.**
- All automated tests use the fake AI and cost nothing. Money is spent only by `npm run eval:ai` and a few live smoke calls.
- The eval runner gains `--budget-usd <n>`. It sums `estimated_cost_usd` over the results it has already stored, plus each new call's estimate, and stops before the next call would cross the limit. Each run uses a budget of 1 at most, the total across runs is 2, and the running total goes in `tests/eval/results/` (gitignored).
- **Plan the spend before running:**
  - only the production config (no thinking-level sweep)
  - only the new lead cases (8 extraction + 8 update) plus about 5 regression cases
  - about 20 calls, roughly $0.10–0.20
  - a full sweep only on request
- Report the spend after every run: the estimate, and the Google AI Studio usage page if the owner can check it.
- The key is stored as `GEMINI_API_KEY_EVAL` and used with `--key-env GEMINI_API_KEY_EVAL`. The runner refuses the production `GEMINI_API_KEY`.

## Verification
- `npm run test:ci` green after every step; `npm run eval:ai` at 90% or better on the lead cases, with the paid key.
- **Manual run on a phone:**
  1. Forward a contact card. Save it, and the card has a tappable number and a WhatsApp link. Forward it again: "who is calling?" shows the history. There's no AI row in `operation_logs`.
  2. Voice: «عميل جديد اسمه أحمد، عايز شقة ٣ غرف في ماونتن فيو أو التجمع لحد ٩ مليون». The lead and request are saved, and the reply shows the matches.
  3. Add a matching unit by WhatsApp. The saved card says "🔥 1 client wants this unit", and a web push arrives (no WhatsApp message). Send it to the client, then open the link three times in a private window. The 🔥 hot alert arrives, and the public page shows nothing about Ahmed.
  4. Voice: «كلمت أحمد، عايز يعاين VIL-08 الجمعة الساعة ٥». The lead is contacted, moved to viewing, and has a Friday 17:00 reminder. Undo works.
  5. A search with no results: tap "Save as client request", give a number, and a lead and request are created.
  6. As a second broker, look up Ahmed's number: only the Q2 notice. The manager gets the duplicate-inquiry notification.
  7. `deal L-0001 VIL-08 8.5M commission 2% split 60/40`: whole EGP amounts that add up exactly; the unit is sold and the lead is won.
  8. Switch the web app to English: every CRM page is in English. Onboard a test broker with `lang: en`: an English start link and guide.
  9. As the admin, export and erase. Every CRM row is gone, the deal survives without client fields, and a re-capture warns.
  10. Search `operation_logs` and the Render logs for Ahmed's phone and name: none.
  11. Set the agency's credits to 50 and use the bot: the hint at 50% and 80%, the switch message at 100%, alerts arriving as web push only (never both), one daily notice at the ceiling, then read ticks; the usage page and the notification log match.

## Critical files (Release 3)
- new, pure: `domain/phone.js`, `domain/leadStages.js`, `domain/leadCard.js`, `domain/leadIntake.js`, `domain/leadImport.js`, `domain/leadUpdate.js`, `domain/commission.js`
- new services: `services/leads.js`, `services/leadImports.js`, `services/deals.js`, `services/privacy.js`
- new: `lib/scheduler.js`, `lib/notifications.js`, `lib/channels/*`, `lib/leadIntake.js`
- touched in `lib/`: `authz.js`, `registry.js`, `buttons.js`, `copy.js`, `rateLimit.js`, `shareLinks.js`, `sheets.js`, `ai.js` (two routes), `util.js`, `onboarding.js`, `search.js` (the no-results button), `drafts.js` (the "clients want this" line)
- `server.js`: the `contacts` case, starting and stopping the scheduler
- web, new: routes `leads`, `leadImport`, `deals`, `notifications` and `settings`, with their views
- web, touched: `web/static/sw.js` (push), the layout (🔔, language switch)
- `db/migrations/011_crm_settings.sql` … `016_deals.sql`
- `config.js`; `package.json` (`web-push`, pinned)
- `tests/**`, `tests/eval/cases.json`
- docs:
  - new: `docs/pilot/crm-howto-ar.md`, `docs/pilot/crm-howto-en.md`, `docs/pilot/broker-howto-en.md`, `docs/pilot/web-howto-en.md`
  - updated: `docs/runbook.md`, the manifest, the registry, `API_CONTRACTS.json`, `SCHEMA_REFERENCE.sql`, `render.yaml`

## Deferred
- A Telegram adapter (built when a trigger in the channel strategy fires; the stub and contract are ready).
- One number per agency (the first cost lever at scale).
- Lead Ads intake, the Conversions API, a full viewing scheduler.
- Messaging clients from the bot number (needs opt-in and marketing templates).
- Lead scoring, a drag-and-drop pipeline board.
- The morning brief, the action pool, the leaderboard: Release 4.
