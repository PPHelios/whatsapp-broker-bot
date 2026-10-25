# FEATURE_REGISTRY.md
## Canonical Matrix of Capabilities, Invariants & Safeguards

This registry documents every user-facing capability, command, interactive callback, and operational lifecycle handler in the WehdatHub engine. Any code refactor or modification MUST preserve the behaviors, validations, and response contracts cataloged below.

---

### 1. Ingress & Media Normalization (`ING`)

| Feature ID | Event / Trigger | Pre-Conditions & Constraints | System Execution & Safeguards | Symmetrical Response Contract |
| :--- | :--- | :--- | :--- | :--- |
| **ING-01** | Photo Ingress (`type: "image"`) | - Ingress limit: Max 15 photos per unit.<br>- Ephemeral memory only. | - Normalizes buffer via Sharp: auto-rotate via EXIF, fit inside `1600x1600`, JPEG Q82.<br>- Concurrency capped at 1; RAM ceiling at 64MB.<br>- If uncompressed photo sent as document (`mime_type: "image/*"` or `.jpg/.png`), routes to image pipeline.<br>- Evaluates `draft.media_items.length`. If $>15$, additional image dropped immediately.<br>- No message per photo (P11, NTF-08): the read tick shows it arrived; the next reply in the draft starts with "📸 N photos received". | **Success (<15):** No message (a reaction would be billed like one); the count rides on the next reply.<br>**Warning (>15):** "⚠️ تم الوصول للحد الأقصى المسموح به (15 صورة) للوحدة. تم تجاهل الصور الزائدة." accompanied by `[Done (Save) ✅]` / `[Cancel ❌]` buttons to prevent conversational dead ends. |
| **ING-02** | Voice Note Ingress (`type: "voice" / "audio"`) | - Ingress limit: $\le 120\text{s}$ for draft/edit; $\le 45\text{s}$ for search.<br>- OGG/Opus clean MIME. | - If active draft/edit session exists: appends buffer to session array in `broker_sessions`.<br>- If no active session: transcribes buffer via Gemini Audio for property search.<br>- If search audio $>45\text{s}$: rejects audio before calling AI. | **Draft Active:** "🎙️ تم استلام الملاحظة الصوتية وإضافتها للمسودة. اكتب *«تم»* عند الانتهاء." with `[Done (Save) ✅]` / `[Cancel ❌]` buttons.<br>**Audio Over Limit:** "⚠️ تسجيل البحث طويل (الحد الأقصى 45 ثانية)." |
| **ING-03** | Multiple Voice Processing | - Broker sends 2 or more voice notes during draft or edit. | - Audio buffers stored sequentially in `broker_sessions`.<br>- Commit phase passes all voice buffers as concurrent `inlineData` parts in a single multimodal Gemini call. | Synthesizes specs across all recordings into a single coherent review card. |
| **ING-04** | Explicit Unit Code Parsing | - Message contains `#`, `code:`, `كود:`, `الكود:`, `كود الوحدة:`, `الكود الداخلي:`. | - Converts Eastern Arabic digits (`٠-٩`) to Western digits.<br>- Enforces alphanumeric `^[A-Za-z0-9_\-\.\/]{2,30}$`.<br>- Rejects Arabic text (`invalidArabic: true`).<br>- Checks DB uniqueness within `agency_id`. | **Valid:** Sets draft code or returns unit details card.<br>**Arabic Error:** "⚠️ كود الوحدة يجب أن يتكون من حروف إنجليزية وأرقام فقط (مثال: #HAS577)."<br>**Conflict:** "⚠️ الكود مستخدم بالفعل لوحدة أخرى." |
| **ING-05** | Image-Only Draft Blocker | - Broker triggers `تم` / `save` on a draft containing photos only. | - Checks `textCount === 0 && voiceCount === 0`.<br>- Blocks draft finalization; preserves images in `broker_sessions`. | "⚠️ لا يمكن تسجيل الوحدة بالصور فقط. يرجى إرسال فويس نوت أو رسالة تحتوي على السعر والمشروع." with `[Done (Save) ✅]` / `[Cancel ❌]` buttons. |
| **ING-06** | Unsupported Media Types | - Inbound message contains `location` or `video` (contact cards are CRM-08 since Release 3). | - Evaluates `switch(message.type)` default branches.<br>- Prevents silent drop by dispatching guidance bubble. | Returns explicit guidance bubble informing broker that location pins, video files, and contact cards must be entered as text or voice notes. |

---

### 2. Bulk Excel Inventory Ingestion (`XLS`)

| Feature ID | Event / Trigger | Pre-Conditions & Constraints | System Execution & Safeguards | Symmetrical Response Contract |
| :--- | :--- | :--- | :--- | :--- |
| **XLS-01** | Excel Document Ingress | - File extension must be `.xlsx`.<br>- File size $\le 5\text{MB}$.<br>- Valid magic bytes (`PK\x03\x04`). | - Downloads file buffer into memory (no `/tmp` disk writes).<br>- Sanitizes dangerous formula execution characters (`=`, `+`, `-`, `@`, `\t`, `\r`) via `Excel.sanitizeCellValue`.<br>- Dynamic multi-column header mapping.<br>- Runs pre-flight dry-run validation in memory. | **Immediate Acknowledgment:** "📥 تم استلام ملف المخزون... الوقت المتوقع: 10 إلى 15 ثانية." |
| **XLS-02** | Atomic Batch Commit & Developer Protection | - Minimum 1 valid row.<br>- Scoped to `agency_id`. | - Wraps valid rows in single database transaction under 64-bit advisory lock `pg_advisory_xact_lock(hashtext($1), hashtext('bulk_import'))`.<br>- Automatically flags developer project sheets as `inventory_type = 'developer_model'` and `is_primary_developer = true`.<br>- Harmonizes typologies (studios 0 beds, villas BUA/land area).<br>- Updates GIN trigrams and wipes `flyer_cache`. | Written directly to `listings` table. |
| **XLS-03** | Status & Rejection Reporting | - Bulk import completed. | - Checks `rejectedRows.length`.<br>- If $>0$, compiles in-memory `مرفوضات_<filename>.xlsx` via `Excel.buildRejectionWorkbook` with highlighted row diagnostics.<br>- Distributed 45s cooldown recorded in `broker_sessions`. | **Zero Rejections:** "✅ تم استيراد المخزون بنجاح: تم حفظ وتحديث X وحدة."<br>**With Rejections:** Dispatches text summary breakdown followed by the `.xlsx` rejection document. Cooldown released immediately on crash. |
| **XLS-04** | Layout & RTL Reading Order | - Generated export / rejection workbooks. | - Overall sheet layout locked to English LTR.<br>- The Arabic description (export) and the rejection reasons are set to RTL reading order (`alignment: { readingOrder: 'rtl' }`). | Professional dual-language workbook delivery. |

---

### 3. Draft State Machine & Creation Lifecycle (`DRF`)

| Feature ID | Event / Trigger | Pre-Conditions & Constraints | System Execution & Safeguards | Symmetrical Response Contract |
| :--- | :--- | :--- | :--- | :--- |
| **DRF-01** | Open Draft (`اضافة`, `add`, `new`) | - Broker is active and authorized. | - Checks/clears existing draft in `broker_sessions`.<br>- Sets 15-minute sliding TTL (`expires_at = NOW() + INTERVAL '15 minutes'`). | "📝 تم فتح مسودة وحدة جديدة. أرسل الصور، التسجيلات الصوتية، أو التفاصيل واكتب «تم» عند الانتهاء." |
| **DRF-02** | Pre-Save Validation Review (`تم`, `حفظ`, `done`, `DRAFT_SAVE`) | - Active draft session exists in `broker_sessions`. | - `Drafts.reviewDraft`: one `listing_extraction` call through the AI gateway over every text and voice note (A1).<br>- `composeFields` sets the top-level columns (delivery, features, resale schedule, market).<br>- `domain/fieldRules.evaluate` applies the field table: mandatory fields block saving; warnings (photos, finishing, bathrooms, floor, delivery, installment details, total vs paid + remaining mismatch > 100 EGP, …) are shown **only here**.<br>- Studios get 0 bedrooms automatically; offices have none; villas use BUA and drop the floor.<br>- The result is staged as `session_data.staged_review`; any new input clears it. | **Missing Blockers:** review card with "⛔ ناقص لإتمام الحفظ" and only `[إلغاء ❌]`.<br>**Complete:** `Describe.reviewCard` with the warnings and `[تأكيد وحفظ ✅]` (`draft_confirm`), `[تعديل ✏️]` (`draft_edit`), `[إلغاء ❌]`.<br>**AI down / quota:** the draft is kept; `[مراجعة تاني 🔄]`. |
| **DRF-03** | Commit Finalization (`draft_confirm`) | - Active draft with an `ok` staged review.<br>- Broker authorized. | - `Drafts.commitStagedReview` commits **only the staged review** (A2); without one it re-reviews.<br>- Atomic draft consumption (`DELETE ... RETURNING session_data`): a double tap saves once.<br>- **Insert-only:** a stated code that exists (`23505` on `(agency_id, code_norm)`, case- and digit-folded) is never overwritten; the draft is kept. A generated code that collides is regenerated.<br>- Sets `confirmed_at`; links the photos uploaded at ingest in `listing_images` (`role = NULL`). | **Saved:** one `Describe.savedCard` message with `[نص العميل 📱]`, `[الكتالوج 📄]`, `[تعديل ✏️]` (no warnings).<br>**Code taken:** "⚠️ الكود #CODE مستخدم لوحدة أخرى في الوكالة…" with `[مراجعة 🔄]` / `[إلغاء ❌]`. |
| **DRF-04** | Draft Inactivity Expiration | - No incoming messages for $>15$ minutes. | - Evaluated at message arrival or background sweep.<br>- Clears expired draft session from `broker_sessions`. | "⏳ انتهت صلاحية المسودة (15 دقيقة بدون نشاط). يرجى بدء إضافة جديدة بإرسال الصور أو المواصفات." |
| **DRF-05** | Discard Draft (`الغاء`, `cancel`, `DRAFT_CANCEL`) | - Active draft session exists. | - Purges session row from `broker_sessions`.<br>- Clears uncommitted image references. | "🗑️ تم إلغاء المسودة وتفريغ البيانات بنجاح." |
| **DRF-06** | Replace Media (`استبدال`, `replace`) | - Active draft session exists. | - Empties stored photo buffer array in `broker_sessions`.<br>- Retains recorded text notes and voice notes. | "🔄 تم مسح الصور السابقة من المسودة. أرسل الصور الجديدة الآن." |

---

### 4. Interactive Editing Engine (`EDT`)

| Feature ID | Event / Trigger | Pre-Conditions & Constraints | System Execution & Safeguards | Symmetrical Response Contract |
| :--- | :--- | :--- | :--- | :--- |
| **EDT-01** | One-Shot Patch (`تعديل <CODE> <INSTRUCTIONS>`) | - `canEdit(broker, listing)` is true. | - Registry `edit` command → `Edits.startEdit` with the instructions, reviewed at once (A3).<br>- AI extraction of the stated changes (local price parser when the AI is down) → `composeFields` with the existing row → field table → `diffPatch`.<br>- The patch and the row `version` are staged in `broker_sessions` (`edit`, 30 minutes). | "✏️ التعديلات: السعر" + `Describe.reviewCard` with `[تأكيد التعديل ✅]` (`edit_confirm`) / `[إلغاء ❌]` (`edit_cancel`). |
| **EDT-02** | Multi-Turn Edit Session (`تعديل <CODE>` alone, or `edit:<CODE>` button) | - `canEdit(broker, listing)` is true. | - Opens an edit session (30 minutes).<br>- Follow-up text and voice join the edit and never become a search (A4).<br>- `تم` / `edit_review` stages the review; `edit_confirm` applies it through `applyListingPatch` with the version seen at review: a change made meanwhile returns a conflict, never an overwrite (optimistic locking).<br>- Unstated fields keep their values; a primary unit stays primary. | "✏️ تعديل #CODE: ابعت التعديلات (كتابة أو فويس)، وبعدين اكتب «تم» للمراجعة."<br>**Conflict:** "⚠️ الوحدة #CODE اتعدلت من شخص تاني أثناء المراجعة. راجع التعديل تاني." |
| **EDT-03** | Direct Price Update (`سعر <CODE> <VAL>`, `تعديل سعر <CODE> إلى <VAL>` (A5), `price <CODE> to <VAL>`, voice) | - Resale inventory only.<br>- Valid price via `parseEgyptianPrice(raw).priceValue`. | - Registry `price` command → `Edits.quickUpdate` under the advisory and row locks → `applyListingPatch` (`price_display` recomputed, `confirmed_at`, `version + 1`, `flyer_cache` cleared; the trigger rebuilds the search text). | "✅ سعر #CODE بقى *9 مليون*." with the card buttons. |
| **EDT-04** | Developer Price Guard | - Unit is marked `is_primary_developer = true` or `inventory_type = 'developer_model'`. | - Intercepts direct price mutation attempts.<br>- Blocks inline price edits to prevent corrupting certified payment matrices. | "⚠️ لا يمكن تعديل أسعار مشاريع المطورين مباشرة لارتباطها بجدول أقساط معتمد. يرجى رفع شيت الأسعار المحدث." |
| **EDT-05** | Mutation Cascade Execution | - Any attribute patch committed (price, finishing, area, bedrooms). | - Updates primary DB column.<br>- Re-synthesizes Arabic (`title`) and English (`title_en`) titles.<br>- Re-runs `clean_arabic_text` to update `search_text_normalized`.<br>- Purges `flyer_cache = '{}'::jsonb`.<br>- Preserves `listing_images` role curation. | Refreshes listing and presents updated unit preview card. |

---

### 5. Unit Lifecycle & Permanent Deletion (`LFC` / `DEL`)

| Feature ID | Event / Trigger | Pre-Conditions & Constraints | System Execution & Safeguards | Symmetrical Response Contract |
| :--- | :--- | :--- | :--- | :--- |
| **DEL-01** | Delete Request (`حذف <CODE>`, `delete`) | - `canEdit(broker, listing)` is true. | - Acquires 64-bit advisory lock and row lock (`FOR UPDATE`).<br>- Verifies ownership/admin role.<br>- Constructs confirmation dialog with distinct cancel ID `del_cancel:<CODE>`. | Dispatches warning prompt with buttons $\le 20$ chars: `[Delete 🗑️ / تأكيد الحذف 🗑️]` / `[Cancel ❌ / تراجع ❌]`. |
| **DEL-02** | Confirm Deletion (`del_confirm:<ID>:<CODE>`) | - Triggered via interactive button tap. | - Executes inside 64-bit transactional advisory lock.<br>- Collects all image paths from `listing_images` and `flyer_cache`.<br>- Executes `DELETE FROM listings WHERE id = $1` (cascading images).<br>- Dispatches asynchronous, non-blocking `deleteStorageFiles` to Supabase Storage. | "🗑️ تم حذف الوحدة #[CODE] نهائياً ومسح كافة وسائطها وملفاتها من السيرفر." |
| **LFC-01** | Mark as Sold (`اتباعت <CODE>`, `تم البيع`, `<CODE> sold`, voice, `qu:sold:<CODE>`) | - `canEdit`. Without a code: the unit looked at last (1 hour). | - Registry `status` command → `Edits.quickUpdate` → `applyListingPatch` (`status = 'sold'`, `confirmed_at`).<br>- Hidden from search. | "✅ #CODE اتسجلت *مباعة* واختفت من البحث." |
| **LFC-02** | Archive Listing (`أرشفة <CODE>`, `archive <CODE>`, `qu:archive:<CODE>`) | - `canEdit`. | - Same path, `status = 'archived'`. Hidden from search; record kept. | "📁 #CODE اتأرشفت واختفت من البحث." |
| **LFC-03** | Still Available / Reactivate (`لسه متاحة <CODE>`, `متاحة`, `تفعيل`, `active <CODE>`, `qu:available:<CODE>`) | - `canEdit`. | - Same path, `status = 'active'` and `confirmed_at = now()` (availability vouched for today). | "🟢 #CODE *متاحة* — تم تأكيد التوفر اليوم." |
| **QU-01** | Quick-Update Menu (`qu_menu:<CODE>` button on a card) | - Unit card shown. | - Interactive list (`Buttons.quickSections`): still available, sold, archive, edit details. Rows map to `qu:<action>:<CODE>`. | "⚙️ تحديث سريع للوحدة #CODE:" list menu. |

---

### 6. Search & Collision Management (`SCH` / `COL`)

| Feature ID | Event / Trigger | Pre-Conditions & Constraints | System Execution & Safeguards | Symmetrical Response Contract |
| :--- | :--- | :--- | :--- | :--- |
| **SCH-01** | Multimodal Search Query (the reply ends with the web "refine and see all" link, WEB-07) | - Text or transcribed voice note.<br>- No active draft/edit session open. | - **One service** (`services/search.js`) for text and voice: AI route `search_parse` (8 s deadline) → language-neutral filters (`domain/searchQuery.js`); the local parser on any AI failure.<br>- Arabic, English or mixed wording gives the same filters, so the same units in the same order.<br>- **Intent guard (B2):** small talk and requests with no filter never query; a described unit points to "اضافة".<br>- Filters: code, sale/rent, type, primary/resale, compound/developer/area keys (bilingual), price, area, bedrooms, bathrooms, floor, finishing, furnishing, delivery (ready / by year), payment (cash, installments, max down payment, max installment), features.<br>- **Pass 1 (strict)**, then **Pass 2 (relaxed):** price/area ±15%, bedrooms ±1, place locked. | One message: the interpretation, then up to 5 `Describe.searchResult` lines (compact line + features line). `[المزيد ➡️]` when more exist.<br>Pass 2: "⚠️ مفيش تطابق تام — أقرب النتائج". Zero: "🔍 مفيش وحدات مطابقة…". |
| **SCH-02** | Search Pagination (`MORE_SEARCH` / `المزيد` / `more`) | - Active search state (`search_state`, 30 minutes). | - Pages the **id snapshot** taken at search time (B1): no repeats or shifts when units are added or sold meanwhile; sold units are skipped.<br>- "المزيد" typed while a draft is open pages the search instead of joining the draft (B4). | Next 5 results with `[المزيد ➡️]`, or "🏁 دي كل الوحدات المطابقة." |
| **COL-01** | Draft vs. Search Collision | - Broker sends text/audio with explicit search keywords (`عايز`, `ابحث`, etc.) while a draft is open. | - Intercepts query; detects search intent (property type words alone do not trigger collision).<br>- Stores the query server-side in `broker_sessions` (`pending_search`, 15-min TTL).<br>- Halts automatic draft append. | "⚠️ لديك مسودة وحدة قيد الإضافة حالياً. هل تريد إلغاء المسودة والبحث في المخزون بدلاً من ذلك؟"<br>Buttons: `[🔍 إلغاء والبحث]` (`cancel_and_search`) / `[📝 إكمال المسودة]` (`draft_edit`). Tapping search runs the full stored query; legacy `cancel_and_search:<b64>` ids still work. |

---

### 7. Deliverables & Marketing Outputs (`DEL`)

| Feature ID | Event / Trigger | Pre-Conditions & Constraints | System Execution & Safeguards | Symmetrical Response Contract |
| :--- | :--- | :--- | :--- | :--- |
| **DEL-01** | Luxury Brochure Curation & Render (`flyer:lang:theme:CODE` / `كتالوج <CODE>`) | - Brochure requested.<br>- 20s distributed cooldown in `broker_sessions`. | - **One pipeline** `renderFlyerOnDemand` (A7/V1); the model comes from `Describe.flyerModel`.<br>- Lazy Vision Curation: uncurated photos (`role IS NULL`) → 768px thumbnails → 1 Gemini Vision call (hero facade, diversity quotas) → persisted order.<br>- Satori/Sharp render in a worker thread (one job at a time, bounded queue, timeout).<br>- Cached in `flyer_cache` under a key that follows the data; a changed unit gets a fresh flyer. | **One message**: the flyer image with its caption. |
| **DEL-02** | Client Ad Copy (`عميل <CODE>` / `client <CODE>`; active units end with a client share link, WEB-17) | - Unit exists in `listings`. | - Typology-Aware Layout:<br>  * Villas/Townhouses: Suppresses floor; displays BUA, Land Area, Garden, and Roof.<br>  * Studios: Formats open-concept studio cleanly.<br>- Arabic (`عميل`): Standard broker terminology, owner equity vs. developer debt.<br>- English (`client`): Executive LTR format.<br>- Zero system metadata or technical notes. | Forwardable WhatsApp ad copy bubble with broker signature. |
| **DEL-03** | Installment Matrix Overview (`plans_view:<CODE>` / `جدول <CODE>`) | - Developer model with `payment_terms.plans`. | - Formats approved payment plans (Down payment, years, quarterly installment, discounts).<br>- Avoids $>3$ button traps; presents Interactive List Menu with options to select specific plans (`plan_select:<CODE>:<ID>`). | Interactive List Menu presenting up to 10 payment plan options. |
| **DEL-04** | Single-Plan Client Ad Copy (`plan_select:<CODE>:<ID>`) | - Plan selected from `plans_view` list. | - Formats verified forwardable WhatsApp text via `financials.formatSinglePlanAdCopy` with net price, installment amount, and maintenance splits. | Delivers single forwardable client pitch for the selected plan. |
| **DEL-05** | Multi-Plan Excel Export (`compare_excel:<CODE>`) | - Developer model with payment plans. | - Compiles multi-tab streaming `.xlsx` workbook via `Excel.buildMultiPlanWorkbook`.<br>- Tab 1: Comparison Matrix. Tabs 2+: Chronological cash-flow schedules with maintenance balloon payments.<br>- Layout locked to English LTR; Arabic columns set to RTL reading order. | Delivers `Payment_Plans_[CODE].xlsx` document bubble. |
| **DEL-06** | 2D Floor Plans & Collateral (`layout <CODE>` / `مخطط <CODE>`) | - Unit exists in `listings`. | - Extracts links from `listing.collateral` JSONB (layout PDF, master plan, drive kit, project brochure). | Formats organized list of verified external collateral links. |
| **DEL-07** | Full Agency Inventory Export (`تصدير`, `export`, `excel`, `شيت`) | - 60s distributed cooldown in `broker_sessions`. | - Queries active listings scoped to `agency_id`.<br>- Generates executive multi-column `.xlsx` workbook via `Excel.buildAgencyInventoryWorkbook`.<br>- In-memory stream directly to WhatsApp document API. | Delivers `Inventory_[DATE].xlsx` document bubble. Releases cooldown immediately on generation failure. |
| **DEL-08** | Multi-Line Forwarded Listing Card Interceptor | - Broker pastes or forwards formatted multi-line listing card into chat. | - Extracts embedded unit code via regex.<br>- Detects embedded intent (`جدول` $\rightarrow$ plans, `كتالوج` $\rightarrow$ flyer, `عميل` $\rightarrow$ client copy, `مخطط` $\rightarrow$ layout).<br>- If no explicit action, routes to direct unit inspection card with interactive buttons.<br>- Prevents false leak into property search and eliminates `SILENT_DROP_PREVENTED` error bubbles. | Executes requested deliverable or displays unit card with management buttons. |

---

### 8. Inventory Analytics & Summary (`STATS`)

| Feature ID | Event / Trigger | Pre-Conditions & Constraints | System Execution & Safeguards | Symmetrical Response Contract |
| :--- | :--- | :--- | :--- | :--- |
| **STATS-01** | Agency Inventory Summary (`مخزون`, `المخزون`, `stats`, `احصائيات`, `summary`) | - Broker is active and authorized. | - Executes single aggregated PostgreSQL query scoped to `agency_id`.<br>- Calculates total, active, sold, archived, resale, and developer units.<br>- Computes total active portfolio valuation and average unit asking price.<br>- Ranks top 3 geographic hubs by inventory density.<br>- Attaches quick-reply buttons (`[Export Excel 📊]`, `[New Unit 📝]`). | Formatted executive inventory summary card with interactive action buttons. |

---

### 9. System, Telemetry & Security Utilities (`SYS` / `SEC`)

| Feature ID | Event / Trigger | Pre-Conditions & Constraints | System Execution & Safeguards | Symmetrical Response Contract |
| :--- | :--- | :--- | :--- | :--- |
| **SYS-01** | Dynamic Help Menu (`مساعدة`, `help`) | - Any incoming text matching help regex. | - Pulls preferred language from broker record.<br>- Returns dynamically compiled command menu reflecting active syntax. | Localized help guide bubble. |
| **SYS-02** | Language Preference Toggle (`lang ar` / `lang en`) | - Broker command. | - Updates `brokers.preferred_lang` in PostgreSQL.<br>- In-memory context updated. | Localized confirmation of language switch. |
| **SYS-03** | Mandatory Operational Telemetry | - Every completed or failed operation. | - Asynchronous, non-blocking insert into `operation_logs` recording latencies (`db_ms`, `gemini_ms`, `total_duration_ms`), tokens, model, cost ($USD), and payload metadata.<br>- Rolling percentiles (p50/p90) calculate dynamic status ETAs. | Telemetry stored safely without interrupting user transactions. |
| **SYS-05** | Outbound Message Counter | - Every WhatsApp send through the dispatcher inside a turn. | - One `operation_logs` row per attempt (`operation_type = 'wa_outbound'`, status success/dropped/failed).<br>- `agency_outbound_daily` view: sent and failed per agency per Cairo day. | No user-visible output; used to size the WhatsApp pool. |
| **SYS-06** | Migrations on Boot | - `start()` with `MIGRATE_ON_BOOT` not `false`. | - `lib/migrate.js` applies pending `db/migrations` in order under an advisory lock, each in its own transaction, recorded in `schema_migrations`. | Logged `[MIGRATE] applied …`; a failed migration stops the boot. |
| **ONB-01** | Agency Onboarding (`npm run onboard -- <file> [--dry-run]`) | - Valid onboarding JSON. | - Creates/updates the agency (by name) and brokers (by phone) in one transaction; roles and branding; a phone of another agency is refused.<br>- Agency slug: from the file (validated, `SLUG_TAKEN` if another agency has it) or derived once from the name; kept on rename. | Console summary with the slug and the web app address; the brokers get `docs/pilot/broker-howto-ar.md`. |
| **SYS-07** | Scheduler (`lib/scheduler.js`) | - `SCHEDULER_ENABLED` (on outside tests). | - 60 s tick per instance; each job claimed by one instance (advisory xact lock + `crm_jobs` row stamp); watermarks; stale `running` rows reclaimed after 10 min; `crm_job_<name>` telemetry with counts only; a failing job doesn't stop the others. | No user-visible output; `crm_jobs` shows the state. |
| **SYS-08** | One phone rule (`domain/phone.js`, P1) | - Any phone written by a broker, a client, WhatsApp or a file. | - Normalized to international digits; Egyptian mobiles, landlines (no WhatsApp link) and foreign numbers; Arabic digits; `displayPhone`, `waMeUrl`, `telUrl`, `last4`. Every caller delegates to it. | Same number however it is written. |
| **SYS-09** | Error capture & owner alerts (`lib/errorReports.js`) | - Any error caught in a bot turn, webhook, boot recovery, web page, HTTP route, scheduler job, the process (unhandled rejection / uncaught exception) or a broker's browser (`POST /app/client-error`, 20/h). | - One `error_events` row (`kind = 'error'`): fingerprint, phone-masked message, repo-relative stack, agency, broker, message id, path.<br>- One Telegram alert to `ALERT_TELEGRAM_CHAT_ID` per fingerprint per `ALERT_EVERY_MIN` (claimed in SQL, so several instances don't double-alert).<br>- 4xx request errors are not captured. Rows deleted after 90 days. | **Bot:** "❌ … temporary service error (#E42) … type *bug* and what happened."<br>**Web:** error page with `#E42` and a 🐞 Report a problem link. |
| **SYS-10** | Bug reports (`bug …` / `بلاغ …`, `/app/report`) | - Bot: *bug*, */bug*, *report bug*, *بلاغ* (with or without the description), *مشكلة* alone or with a colon; a bare one asks and the next text (within 10 min) is the report, *cancel* / *إلغاء* drops it.<br>- Web: 🐞 at the bottom of every signed-in page.<br>- 10 reports an hour per broker. | - `error_events` row (`kind = 'report'`, `source` whatsapp/telegram/web) with the broker's last actions and recent `#E` ids; phones masked.<br>- Telegram alert to the owner every time. | "✅ Got it, report #R12. Thank you!" / "✅ وصلنا البلاغ #R12."; over the limit: "⚠️ Too many reports this hour". |
| **SYS-04** | Unregistered Number | - Sender has no active broker row. | - Message is still recorded in `inbound_messages`.<br>- Notice is sent at most once per 24h per number. | Bilingual "number not registered, ask your agency admin" notice, once per 24h. |
| **SEC-01** | Webhook Cryptographic Verification | - Inbound HTTP POST to `/webhook`. | - Validates Meta's `X-Hub-Signature-256` HMAC-SHA256 signature against `WHATSAPP_APP_SECRET` using `crypto.timingSafeEqual`. | **Invalid:** HTTP 401 Unauthorized.<br>**Valid:** Proceeds to payload ingestion. |
| **SEC-02** | Row-Level Tenant Isolation | - Every SQL query across all modules. | - Enforces `WHERE agency_id = $1` on all SELECT, UPDATE, and DELETE statements.<br>- Cross-agency data access is structurally impossible. | Absolute multi-tenant segregation. |
| **SEC-03** | Startup Crash Recovery & Webhook Deduplication | - Server process boot (`bootRecovery()`) and webhook ingress. | - Ingress inserts `msg_id` into `inbound_messages` (`ON CONFLICT DO NOTHING`) to eliminate duplicate deliveries.<br>- Boot sweep recovers unhandled records (`status = 'new'`) from last 15 mins using `FOR UPDATE SKIP LOCKED`. | Prevents message loss across Render restarts or container cycling. |
| **SEC-04** | Distributed Multi-Pod Session Persistence | - All transient state, drafts, edits, search pagination, and cooldowns. | - Persisted in PostgreSQL `broker_sessions` table (`session_type IN ('draft', 'edit', 'search_state', 'session_context', 'cooldown_*')`).<br>- Zero reliance on Node.js process memory (`new Map()`). | Eliminates state amnesia across Render cold boots, free-tier idling, and blue/green deployment crossovers. |

---

### 10. Web App & Public Pages (`WEB`) — Release 2

| Feature ID | Event / Trigger | Pre-Conditions & Constraints | System Execution & Safeguards | Symmetrical Response Contract |
| :--- | :--- | :--- | :--- | :--- |
| **WEB-00** | Links & agency slugs | - Any absolute link sent out. | - Built only by `lib/links.js` from `PUBLIC_BASE_URL` (`config.publicUrl`).<br>- `agencies.slug`: unique, URL-safe, not a reserved path (`app`, `webhook`, `health`, …). | Public unit links read `<PUBLIC_BASE_URL>/<agency-slug>/<unit-code>?s=<token>`. |
| **WEB-01** | Web shell (`GET /app/`, `/app` → 301 `/app/`) | - Any browser. Same Express app as the webhook. | - Server-rendered HTML (`web/html.js`: every value escaped) with htmx 2 (pinned, served from `/app/static/`, `allowEval: false`, `selfRequestsOnly`).<br>- Arabic RTL by default (`<html lang="ar" dir="rtl">`); LTR for English.<br>- Headers on every page: strict CSP (no inline script or style, `frame-ancestors 'none'`), `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: same-origin`, `noindex`.<br>- State-changing requests from another site (`Sec-Fetch-Site` / `Origin`) get 403. | RTL page with the top bar (search, units, add, import) once signed in. |
| **WEB-02** | PWA (`/app/manifest.webmanifest`, `/app/sw.js`) | - Browser with service workers. | - Manifest: `scope` and `start_url` `/app/`, standalone, icons 192/512/maskable/SVG.<br>- Service worker served at `/app/sw.js` (`Service-Worker-Allowed: /app/`, `no-cache`), registered with scope `/app/`. It precaches the versioned static files and the offline page, serves `/app/static/` cache-first, and pages network-only with the offline fallback. It never caches private pages, POSTs or anything outside `/app/`.<br>- Static files are hashed in memory at boot (`?v=<hash>`, immutable cache); a new deploy is a new cache. | Installable app; "📴 مفيش اتصال بالإنترنت" page when offline. |
| **WEB-03** | Sign-in link (`دخول` / `login` / `الموقع` on WhatsApp, or the phone form on `/app/login`) | - Active broker. Rate limits: 6/hour per broker (WhatsApp); 5/hour per number and 20/hour per IP (web). | - One-time token (15 minutes), stored as a SHA-256 hash; link built by `Links.loginLinkUrl`.<br>- The web form answers the same for unknown numbers and sends through `dispatcher.notify` (counted). | "🌐 رابط الدخول لموقع WehdatHub (صالح 15 دقيقة ولمرة واحدة): <link> 🔒 متبعتوش لحد."<br>Web: "📲 لو الرقم ده مسجل، هيوصلك رابط الدخول على واتساب…". Over the limit: "⏳ طلبت روابط دخول كتير…" / HTTP 429. |
| **WEB-04** | Confirm and sign in (`GET /app/login/confirm?t=` → `POST`) | - Unused, unexpired token; active broker. | - GET shows "👋 أهلاً <name>" and a button and uses nothing (link previews are safe); `Referrer-Policy: no-referrer`.<br>- POST (double-submit CSRF) consumes the token atomically and starts a 30-day session (new id; hashed; `HttpOnly`, `SameSite=Lax`, `Secure` `__Host-` cookie). | 303 to `/app/`. Used/expired/unknown link: 410 "⌛ الرابط ده انتهى أو اتستخدم قبل كده" pointing back to «دخول». |
| **WEB-05** | Session, CSRF, sign-out (`POST /app/logout`) | - Every private page. | - No session: 303 to `/app/login?next=…` (htmx: `HX-Redirect`).<br>- Every write needs the session CSRF token; private pages are `no-store`.<br>- Deactivating a broker or expiry ends the session; sign-out revokes it. | Sign-out: 303 to `/app/login`. Missing/wrong CSRF token: 403. |
| **WEB-06** | Web search (`/app/search?q=` free text, refine form, `?f=<token>`) | - Signed in. Free text: 60/minute per broker. | - `services/search.js`: same parse, intent guard, strict then relaxed pass, same order as WhatsApp.<br>- Pages of 20 from the id snapshot (up to 100); every feature as a tag.<br>- The refine form shows the parsed filters; submitting it (or a token) runs without AI. Tokens are sanitized; the agency comes from the session. | Interpretation, "N وحدة مطابقة", results with code links, pager, "⭐ احفظ البحث". Relaxed: "⚠️ مفيش تطابق تام — أقرب النتائج". None: "🔍 مفيش وحدات مطابقة…". Small talk: guidance, no results. |
| **WEB-07** | "Refine and see all" from WhatsApp | - Any WhatsApp search reply. | - The reply ends with `🌐 عدّل البحث وشوف كل النتائج: <PUBLIC_BASE_URL>/app/search?f=<token>` (same message). Opening it runs the same filters without another AI call. | The same units in the same order, all of them, with the refine form. |
| **WEB-08** | Saved searches (`/app/searches`) | - Signed in; at most 50 per broker. | - Save (name + filters), list with "🆕 N جديد" (results not seen since the last run), open (resets), delete. Private to the broker, agency-scoped. | Saved list; opening shows the results. |
| **WEB-09** | Units in the web app (`/app/units`, `/app/units/<code>`) | - Signed in; same agency. | - List by status (active/sold/archived), whole agency or mine; unit page with every fact, the internal lines and photos. Another agency's code is not found. | Unit page with ✏️ Edit for brokers who may edit it. |
| **WEB-10** | Add a unit (`/app/units/new`) | - Signed in. Up to 15 photos (images only, 10 MB each). | - Form = full desired state; `domain/fieldRules` blockers stop the save (422), warnings only in the review panel.<br>- `listingStore.createListing`: insert-only; a used code (any case or digits) → 409, nothing written, uploaded photos removed.<br>- Photos normalized like WhatsApp (1600 px JPEG Q82) and linked in order. | 303 to the unit page "✅ تم الحفظ" (no warnings there). Code taken: "⚠️ الكود #CODE مستخدم لوحدة أخرى في الوكالة". |
| **WEB-11** | Fill from a description or a voice note (`POST /app/units/extract`) | - 20 per 10 minutes per broker; AI quota applies. | - `L.extractPropertyDetails` (same prompt and gateway as WhatsApp) on the text and/or the recording (inline audio); merged into what the form already says. | The form comes back filled: "✨ اتملت البيانات من الوصف. راجعها قبل الحفظ." AI down: "❌ تعذر قراءة الوصف حالياً…", form kept. |
| **WEB-12** | Review (`POST /app/units/review`, htmx) | - Any form state. | - `Rules.evaluate` → blockers (`data-blocker`), warnings (`Rules.warningLine`), preview from `Describe.factLines`. | "📋 مراجعة قبل الحفظ" panel. |
| **WEB-13** | Edit a unit (`/app/units/<code>/edit`) | - `canEdit` (owner or manager); same agency. | - Advisory + row lock; field table; `diffPatch`; `applyListingPatch` with the version the form was opened at (optimistic lock); `confirmed_at`, `version + 1`, flyer cache cleared.<br>- Remove and add photos in the same save; removed files deleted from storage after commit. | 303 to the unit page. Changed meanwhile: 409 "⚠️ الوحدة #CODE اتعدلت من شخص تاني أثناء التعديل…". Not allowed / other agency: 404. |
| **WEB-14** | Excel diff import (`/app/import` → `POST /app/import/excel` → `/app/import/<id>` → apply) | - `.xlsx` ≤ 5 MB, ≤ 2,000 rows; uploads 30 per 10 minutes per broker. | - Header row found in the first 10 rows (Arabic/English, the bot's export too); only stated columns count; formula cells give their value.<br>- Preview: new / changed (from → to) / unchanged / invalid (reasons) / not yours / repeated code; missing units offered for archiving (opt-in).<br>- Apply once; rows via `createListing` / `applyListingPatch` with the planning version (conflicts reported, never overwritten). | Preview page with checkboxes; "✅ اتطبق" summary (created, updated, archived, conflicts). Bad file: 422 with the reason. Second apply: 409. |
| **WEB-15** | Group import (pasted forwards or a WhatsApp chat export `.txt`/`.zip`) | - Up to 40 candidate posts; AI quota applies. | - Posts that describe a unit (price + area/rooms; requests skipped), de-duplicated; extraction in the background, two at a time; likely duplicates of active units, or of an earlier post in the same paste (P13 rule), flagged and unticked.<br>- Apply creates the ticked complete posts (generated codes); the poster is kept as internal co-broker. | "⏳ جاري قراءة البوستات N / M" (polls), then the posts with their state; "🔍 ملقيناش بوستات فيها وحدات" when none. |
| **WEB-15b** | Unit duplicate warning (P13) | - A complete unit with a place, area and price. | - Same place (compound, else district/city/location), listing type, bedrooms, compatible type, area and price within 5%, active units of the agency only. | WhatsApp review card: "⚠️ شكلها نفس الوحدة VIL-08" + link, Confirm becomes «احفظ برضه ✅»; web: review panel notice, first Save 409 with «احفظ برضه». |
| **WEB-16** | Bulk edit (`POST /app/units/bulk` from the units list) | - Up to 200 units. | - Still available / sold / archive / price ± % (−50…+100, rounded to 1,000; developer prices skipped), each with the lock, `canEdit` and `applyListingPatch`. | Summary: updated, not yours, developer prices skipped, changed at the same moment, not found. Invalid action or percent: 422. |
| **WEB-17** | Client share link (WhatsApp client copy; web "🔗 رابط للعميل") | - Active unit; same agency. | - New random token per share, stored hashed, tied to the unit and the sharing broker (180 days); built by `Links.unitPageUrl`.<br>- WhatsApp: the link is appended to the client copy in the same message (sold units: no link). | "🔗 الصور والتفاصيل: <PUBLIC_BASE_URL>/<agency-slug>/<CODE>?s=<token>". Web: the link, a wa.me share and the broker's links with their opens. |
| **WEB-18** | Public unit page (`GET /<agency-slug>/<unit-code>?s=<token>`) | - Slug, code and live token of the same unit; 120/minute per IP. | - Rendered only from the allowlist serializer (`domain/publicUnit.js`); no internal field can appear.<br>- `noindex` (header and meta), no-store, no referrer, no scripts; OG tags for the preview; `?lang=en`.<br>- Anything that does not match: the same 404. Sold/archived: 410 with nothing else. | Photos, every client-facing fact and feature, the summary, the broker's contact (call / WhatsApp). |
| **WEB-19** | Opened alert | - A real browser opens a share link. | - Counted unless it is a link preview/crawler or a signed-in broker of the agency; alert to the sharing broker at most once per 6 hours per link (`dispatcher.notify`, counted). | "👀 العميل فتح رابط الوحدة #CODE (N مرات). وقت مناسب تتابع معاه." |

---

### 10b. Notifications, Channels & Message Credits (`NTF`) — Release 3

| Feature ID | Event / Trigger | Pre-Conditions & Constraints | System Execution & Safeguards | Symmetrical Response Contract |
| :--- | :--- | :--- | :--- | :--- |
| **NTF-01** | Notify a broker (`notifyBroker`) | - An event with a dedupe key. | - Inbox row first (`UNIQUE (broker_id, dedupe_key)`); quiet hours hold; 2-minute merge; one channel: WhatsApp (chosen + window open + credits < 100%) → web push → inbox; channel, reason and status recorded. | One message on one channel, or the inbox only; never both. |
| **NTF-02** | Held and merged delivery (scheduler `notifications`) | - Rows `held`/`queued` with `deliver_after` due. | - Grouped per broker and kind; 5 lines + "and N more"; inactive brokers skipped. | One grouped message. |
| **NTF-03** | Web push | - Subscription saved from ⚙️ Settings; VAPID keys configured. | - Payload `{ title, body, url }` only; phone-like digits scrubbed; `/app/` URLs only; 404/410 remove the subscription. | Browser notification that opens the page. |
| **NTF-04** | Inbox and log (`/app/notifications`, `/log`) | - Signed in; the log is managers only. | - Own rows only (broker and agency); open marks read and redirects to an `/app/` path. | 🔔 count in the top bar. |
| **NTF-05** | Settings (`/app/settings`) | - Signed in, CSRF. | - Language; WhatsApp or website per kind; quiet hours; push on/off; test push. | "Saved". |
| **NTF-06** | Message credits (`lib/credits.js`) | - Every WhatsApp send through the dispatcher. | - Agency month, global month, broker day/week caps, sign-in ceiling; ok/warn/limit/ceiling; hints once per level; one ceiling notice a day then read ticks only. | Hint lines on existing replies; usage page. |
| **NTF-07** | Usage (`/app/usage`) | - Signed in; caps form managers only. | - My usage by action today/month; agency meter; per broker (managers); credits and caps saved per agency. | Numbers equal `operation_logs`. |
| **NTF-08** | Photos without a message (P11) | - A photo in a draft. | - No reaction (billed); allowed silent drop; the next reply in the draft starts with "📸 N photos received". | Read tick only, then the count. |

### 10c. CRM Leads (`CRM`) — Release 3

| Feature ID | Event / Trigger | Pre-Conditions & Constraints | System Execution & Safeguards | Symmetrical Response Contract |
| :--- | :--- | :--- | :--- | :--- |
| **CRM-01** | Capture a lead (`captureLead`) | - A valid phone (any spelling; up to 3); kind; lawful basis. | - One lead per number per agency across all its numbers; per-agency lock; a broker's lead is theirs; erased numbers flagged. | created / merged / colleague / erased_before / invalid. |
| **CRM-02** | Q2 notifications | - A lead created, claimed or a colleague duplicate. | - Every manager but the actor alerted; the assignee gets the card; the duplicate's owner and other brokers hear nothing. | Inbox rows through the notification centre. |
| **CRM-03** | Q1 visibility | - Any read or change. | - Assigned broker or manager; unassigned = managers; other agency = not found; reassigned = access lost, events kept. | `null` / `forbidden` / `not_found`. |
| **CRM-04** | Stage, note, contacted, follow-up | - Rights; optional version. | - Any stage to any other; lost needs a reason; one open follow-up; viewing unit in the agency; stale version = conflict; every change one event. | The updated lead and the event id. |
| **CRM-05** | Undo | - The actor's own event (or a manager), within 10 minutes, lead unchanged since. | - Restores the stored previous fields; `undo` event; expired, undone or changed = refused. | ↩️ result or the reason. |
| **CRM-06** | Lists, search, who is calling | - Signed-in broker. | - Role-scoped SQL; pages of 20; filters; name, digits or `L-0042`; a colleague's number only flagged. | Rows + `more`; `{ lead, elsewhere }`. |
| **CRM-08** | Contact card / bare number (who is calling?) | - No unit draft or lead draft open (for a bare number). | - No AI; every number on the card; own lead → card; colleague's → Q2 copy only; new → [➕ Save as client]. | One message. |
| **CRM-09** | «ليد» / lead intake | - Text, a forward, the next message after «ليد», or a spoken «ليد …». | - One `lead_extraction` call (fenced); phones via the one phone rule; several → list; none → ask (kept 30 min); "I understood" → saved only on ✅ Confirm; AI down → save the number alone. | "I understood" card, then the lead card. |
| **CRM-10** | Forwarded client text | - A phone, no unit code, not a unit post. | - "Is this a client?" [➕ Save as client] [🔍 Search]; the text waits server-side. | One message. |
| **CRM-11** | The card and its buttons | - Any card. | - Number + wa.me link; [📞 Called] [📅 Follow-up] [🔄 Stage] (seller first card: [➕ Add their unit], owner prefilled); reload + rights on every tap; ↩️ Undo (a stack, 10 minutes). | One message per tap. |
| **CRM-12** | CRM commands (Q13) | - Arabic or English. | - my leads, followups, L-0042, assign … to … (managers), help lists both. | One message. |
| **CRM-13** | Web leads list (`/app/leads`) | - Signed in. | - Role-scoped; tabs, search, filters, pages of 20; managers' pipeline and overdue per broker. | List with empty state and first action. |
| **CRM-14** | Web add lead (`/app/leads/new`) | - CSRF; 120 writes/min. | - Fill from message or voice (AI, 20/10 min, typed fields kept); duplicate notice before saving; Q2 outcomes (merged → that lead, colleague → 409 + manager told, erased → tick to confirm). | Redirect to the lead page. |
| **CRM-15** | Web lead page (`/app/leads/<ref>`) | - Visible lead (else 404). | - Real Call/WhatsApp, stage, follow-up (Cairo time, unit), note, assign (managers), timeline; version check (409), Undo. | One page; notices on the page. |
| **CRM-16** | Web share target (`/app/share`) | - Android installed site; signed in. | - Shared text prefilled with its numbers; nothing saved. | The add form. |
| **CRM-17** | Lead file import (`/app/leads/import`) | - Signed in; CSRF; lawful basis + confirm tick; 30 uploads/10 min. | - `.csv`/`.xlsx`, ≤ 5 MB, ≤ 2,000 rows, Arabic or English headers; preview per row (new, merge fills blanks, colleague left alone, erased before, repeated, invalid); managers: broker column or round-robin; apply once (409) in the background with progress; one summary notification. | Preview page, then a progress bar, then the counts. |
| **CRM-18** | Client requests («طلب …» / `request …`, lead page) | - The lead is the broker's (or a manager's); at most 3 per lead; not inside a draft. | - On the open lead (last card shown, 30 min) or `L-0042`; parsed like a search (text = voice); several places; units that fit now recorded, never alerted. | One message: "🔎 طلب L-0042 اتحفظ: …" + up to 5 units that fit + link; web: the Requests section with counts, Remove, the filter form. |
| **CRM-19** | Match alerts (scheduler `match_sweep`, 5 min) | - Alerting request of an open lead; active unit changed since the watermark. | - Same SQL as search on the changed units; one alert per request and unit ever; grouped per broker per sweep; 10 a Cairo day; goes to the current assignee. | "🏠 وحدة جديدة تناسب Sara (L-0001)" / "🏠 N وحدة جديدة تناسب M من عملائك" + lines. |
| **CRM-20** | Wow loop: clients who want a unit, save a no-results search as a request, send to client, hot client | - Agency-scoped; names only for leads the broker may see. | - Saved card "🔥 N" + list + Send; unit page section; no-results [🔔 Save as request] (WhatsApp and web); share link with `lead_id` → `wa.me` + `match_sent`; 3 opens in 48 h → `hot_at` once + one notification. | Saved card line and button; the wa.me link; "🔥 … فتح روابطك 3 مرات في يومين". |
| **CRM-21** | Follow-up and viewing reminders, Done/Postpone, the 24-hour nudge (scheduler `follow_up_reminders`, 1 min) | - Open follow-up of an assigned open lead, due; a new lead uncontacted 24–72 h. | - Claimed once (`SKIP LOCKED`); grouped per broker; quiet hours hold; current assignee; Done/Postpone on WhatsApp and the web inbox; one nudge per lead. | "📅 متابعة: Sara (L-0001)" [✅ خلصت] [📅 أجّل يوم]; "🏠 معاينة 17:00: …" + unit line + 📍; "⏰ … لسه محدش كلمه من 24 ساعة". |
| **CRM-22** | Voice CRM update (wow 3): «كلمت أحمد، عايز يعاين VIL-08 الجمعة الساعة ٥» | - Text or voice; an outcome word; a client of the broker named, referenced or open. | - One `lead_update` call; future time and a known unit required (else asks again); several names → list; colleague refused; applied only on Confirm as one set of events; Undo reverts the set. | "🤖 فهمت كده: … أسجله؟" [✅ تأكيد] [✏️ تعديل] [❌ إلغاء] → "✅ اتسجل: …" [↩️ تراجع]. |
| **CRM-23** | Deals and commission: «صفقة …» / `deal …`, `/app/deals` | - The closing broker on their lead (managers for anyone); commission as % or amount; optional external share and colleague split. | - Review before saving; deal + lead won + unit sold in one transaction (a changed unit refuses all); whole EGP shares that add up; a double tap saves once; role-scoped reads (own share only); managers correct. | Review card "🤝 صفقة جديدة: …" [✅ تأكيد] [✏️ تعديل] [❌ إلغاء] → "✅ اتسجلت الصفقة D-0001. العمولة …، نصيبك …". |
| **CRM-24** | PDPL: export, erase, retention, payload purge | - Managers only (export and erase); the scheduler `privacy` job. | - Zip (.json + .txt) with only the client's data, no-store, 10/h; erase after the last 4 digits (hash kept, deals stripped); 18-month retention with a 30-day warning; payloads purged after 7 days. | "🔒 العميل L-0001 اتمسح نهائياً." |
| **CRM-25** | Web language switch (`?lang=ar|en`, top bar and sign-in pages) | - Any `/app/` page. | - Signed in: saved to `preferred_lang`; signed out: `aq_lang` cookie for sign-in, 404 and 500 pages; every page fully English or Arabic (RTL). | Top-bar link "English" / "عربي". |
| **CRM-26** | Onboarding start links and English guides (`npm run onboard`) | - `bot_phone` in the file or `BOT_PHONE`. | - One `wa.me/<bot>?text=مساعدة` (or `help` for `lang: en`) link per broker, printed on dry run and after onboarding; the bot replies in the broker's language. | "Broker Two (en): https://wa.me/2010…?text=help"; `docs/pilot/broker-howto-en.md`, `web-howto-en.md`. |
| **UNIT-CODE-01** | Short auto unit codes (`NH-V12`) | - A unit saved on WhatsApp, the web form or the group import without a typed code. | - Agency initials + type letter + one running number per agency; typed codes kept; hand-typed numbers skipped; managers edit the initials (My usage, onboarding `code_prefix`). | "✅ اتحفظت NH-V12". |
| **CRM-07** | A broker leaves (P6) | - `onboard --deactivate`. | - Inactive at once; leads to the unassigned pool with events; one manager notification with the count. | "N leads to reassign". |

---

## 11. QA Test Verification & Traceability Baseline

* `TC-ING-01`: 1–15 photos processed into in-memory buffer; sharp resized to 1600x1600 Q82; no message per photo (P11); the next reply counts them; zero text bubbles dispatched.
* `TC-ING-02`: Photo 16 rejected; warning dispatched; action buttons `[Save ✅]` / `[Cancel ❌]` preserved.
* `TC-ING-03`: Voice note $\le 120\text{s}$ appended to session array; search audio $> 45\text{s}$ rejected before AI.
* `TC-ING-04`: Draft containing only photos blocked upon finalization (`textCount === 0 && voiceCount === 0`).
* `TC-ING-05`: Unsupported media (`video`, `contacts`, `location`) returns guided response bubble (zero silent drops).
* `TC-XLS-01`: Valid `.xlsx` ingested via in-memory stream buffer; atomic commit under 64-bit advisory lock.
* `TC-XLS-02`: Cells starting with dangerous characters (`=, +, -, @, \t, \r`) escaped with leading single quote (`'`).
* `TC-XLS-03`: Developer project workbooks auto-flagged as `inventory_type = 'developer_model'` and `is_primary_developer = true`.
* `TC-XLS-04`: Partially rejected batches return `مرفوضات_<filename>.xlsx` with row errors detailed in Column A.
* `TC-DRF-01`: 15-minute sliding TTL enforced via `expires_at = NOW() + INTERVAL '15 minutes'` on `broker_sessions`.
* `TC-DRF-02`: Studios (`property_type = 'studio'` or `bedrooms = 0`) exempt from mandatory bedroom count blocker.
* `TC-DRF-03`: Villas/Townhouses exempt from floor level requirements; BUA and Land Area displayed.
* `TC-DRF-04`: Resale financial discrepancy ($>100$ EGP difference between Total Price and Upfront + Remaining) triggers `deltaWarning`.
* `TC-EDT-01`: Direct price patch (`سعر <CODE> إلى <VAL>`) acquires 64-bit advisory lock, patches `price_value`, regenerates titles, updates GIN trigrams, and purges `flyer_cache`.
* `TC-EDT-02`: Developer units (`is_primary_developer = true`) block direct price mutations.
* `TC-DEL-01`: Lazy Vision executes thumbnail extraction (768px), assigns hero cover (facade/reception only), and commits roles to `listing_images`.
* `TC-DEL-02`: Satori renders 100% English LTR luxury flyers; `arabic-persian-reshaper` strictly forbidden.
* `TC-DEL-03`: Multi-line forwarded listing card with embedded intent (`جدول`) routes directly to payment plans without leaking to search.
* `TC-SCH-01`: Pass 1 strict trigram query on `search_text_normalized`.
* `TC-SCH-02`: Pass 2 automatically widens boundary constraints by $\pm 15\%$ while keeping compound strictly locked.
* `TC-SCH-03`: Search pagination (`MORE_SEARCH`) streams 5 units per turn and updates offset in `broker_sessions`.
* `TC-SEC-01`: Inbound webhooks validated with timing-safe HMAC-SHA256 signature against `WHATSAPP_APP_SECRET`.
* `TC-SEC-02`: Tenant isolation enforced via strict `agency_id = $1` on all database operations.
* `TC-SEC-03`: Render `SIGTERM` initiates drain protocol (HTTP 503 response, 25s window for `inFlight` tasks).
## 12. Test Coverage Map
Legend: ✅ covered by a passing test · 🐞 known defect pinned as `test.failing` (plan ID in brackets) · ⬜ not yet covered.
Router tests send real webhook payloads through the production pipeline (`tests/router/`); unit tests live in `tests/unit/` and `tests/e2e.test.js`. After Release 1 there are no 🐞 rows: every pinned defect is a passing test.

| Feature / TC | Status | Test |
| :--- | :--- | :--- |
| SEC-01 / TC-SEC-01 signature verification | ✅ | `tests/router/webhook-security.test.js` |
| SEC-01 fail-closed secret, unsigned dev opt-in, body limit 413, verify token required | ✅ | `tests/router/foundation.test.js` |
| SEC-02 / TC-SEC-02 tenant isolation (lookup, search, edits) | ✅ | `core-flows`, `search`, `edits` |
| SEC-03 webhook dedup + completed status | ✅ | `core-flows` |
| SEC-03 crash recovery (`bootRecovery`) | ⬜ | — |
| TC-SEC-03 drain returns 503 | ✅ | `webhook-security` |
| SYS-01 help / SYS-02 language toggle | ✅ | `core-flows` |
| SYS-01 help lists only working commands [U1] | ✅ | `core-flows` |
| SYS-03 telemetry: no null agency_id; ctx carries broker and agency | ✅ | `foundation` |
| SYS-05 outbound counter (sent and failed) | ✅ | `foundation` |
| SYS-06 migrations recorded, re-run is a no-op | ✅ | `foundation` |
| ONB-01 onboarding validation and idempotent upsert | ✅ | `tests/unit/onboarding.test.js` |
| WEB-00 slugs (derived, unique, reserved words, kept on rename; JS = SQL); links from PUBLIC_BASE_URL only; onboarding slug | ✅ | `tests/unit/slug-links.test.js` |
| WEB-01 shell (RTL, htmx pinned, CSP and headers, cross-site POST refused, 404s) · WEB-02 PWA (manifest scope, service worker scope/caching, versioned assets) | ✅ | `tests/web/shell.test.js` |
| WEB-03…05 magic link from WhatsApp and the web, GET never consumes, one-time POST, hashed tokens and sessions, 30-day cookie, CSRF, expiry, deactivation, rate limits, open-redirect guard, help lists «دخول» | ✅ | `tests/web/auth.test.js` |
| WEB-06…09 web = WhatsApp ids and order (AI, AI down, link without AI), refine form round trip, every feature as a tag, see all (20 a page), tenant isolation, tampered tokens, small talk, rate limit, saved searches (new count, private), unit pages | ✅ | `tests/web/search.test.js` |
| WEB-10…13 form fields, review blockers/warnings, save refused while blocked, full create (columns, features, schedule, photos normalized), code collision, studio/villa rules, multipart CSRF, image-only uploads, fill from text and voice, AI down, edit = the form (cleared fields, unticked features), optimistic-lock conflict with WhatsApp, photo remove/add, permissions | ✅ | `tests/web/units.test.js` |
| WEB-14…16 Excel preview kinds and from → to, nothing written before apply, apply once, conflict after preview, export round trip unchanged, missing units opt-in archive, banner rows and formulas, bad files, private plans; group import from paste and zipped chat export, chatter skipped, duplicates flagged, co-broker internal, quota per post, polling; bulk status and price %, authz, developer guard, validation | ✅ | `tests/web/imports.test.js` |
| WEB-15b P13 rule (compound, district fallback, type, listing type, 5%), WhatsApp review card warning + Save anyway, web review panel + 409 + force, other agency never a duplicate, two posts of one paste | ✅ | `tests/unit/unit-duplicate.test.js`, `tests/web/units.test.js`, `tests/router/draft-pipeline.test.js`, `tests/web/imports.test.js` |
| WEB-17…19 link in the client copy (same message, hashed token, none for sold units), OG/noindex/no-referrer/no scripts, allowlist with sentinels and the serializer's exact keys, English page, uniform 404s, 410 for sold, reserved paths, rate limit, alerts (previews and colleagues excluded, 6-hour throttle, English), web share with open counts | ✅ | `tests/web/public.test.js` |
| Config: production fail-fast, https base URL, prices, quotas | ✅ | `tests/unit/config.test.js` |
| ING-01 / TC-ING-01 / NTF-08 photo stored, no message per photo (P11), the count in the next reply, no fallback bubble | ✅ | `core-flows` |
| TC-ING-02 16th photo warning with Save/Cancel | ✅ | `tests/router/reply-delivery.test.js` |
| ING-05 / TC-ING-04 image-only draft blocked | ✅ | `core-flows` |
| ING-06 / TC-ING-05 unsupported media guidance | ✅ (video) | `core-flows` |
| DRF-01 open draft · DRF-05 cancel · text append | ✅ | `core-flows` |
| DRF-02 AI extraction + review card [A1]; field table, warnings only in review | ✅ | `core-flows`, `tests/router/draft-pipeline.test.js`, `tests/unit/field-rules.test.js` |
| DRF-03 commit only a reviewed draft [A2]; double tap saves once; code collision never overwrites | ✅ | `core-flows`, `draft-pipeline` |
| ING-04 `#CODE` unit card | ✅ | `core-flows` |
| DEL-01/02 delete with confirmation; owner-only; no fallback bubble | ✅ | `core-flows` |
| LFC-01…03 / QU-01 quick updates by text, voice and button; recent unit; authz | ✅ | `tests/router/edits.test.js` |
| EDT-03 / TC-EDT-01 price update [A5]; EDT-04 / TC-EDT-02 developer price guard | ✅ | `core-flows`, `edits` |
| EDT-01 inline instructions [A3]; EDT-02 multi-turn edit [A4]; optimistic-lock conflict | ✅ | `core-flows`, `edits` |
| Registry matchers, single `canEdit` | ✅ | `tests/unit/authz-registry.test.js` |
| SCH-01 search, agency-scoped; AI outage → local parser | ✅ | `core-flows`, `tests/router/search.test.js` |
| SCH-01 text/voice and ar/en/mixed parity; language-neutral filters | ✅ | `search` |
| SCH-01 intent guard [B2] | ✅ | `core-flows`, `search` |
| SCH-02 / TC-SCH-03 paging from an id snapshot [B1]; "المزيد" inside a draft [B4] | ✅ | `search` |
| Code lookup in any case through `code_norm` [B6, B7] | ✅ | `search` |
| COL-01 draft vs search collision [B3]: long query round trip + legacy buttons | ✅ | `reply-delivery` |
| DEL-02 client copy uses the agency's own code | ✅ | `core-flows`, `tests/unit/known-defects.test.js` |
| Descriptions: golden cases × every surface; nothing internal; no warnings outside review | ✅ | `tests/unit/describe-golden.test.js` |
| Financial schedules (DEL-04/05) [F1–F10] | ✅ | `known-defects`, `tests/e2e.test.js` |
| Client copy [C1–C7] | ✅ | `known-defects` |
| DB search text: one trigger, one normalizer [D1, D2]; JS/SQL normalizers agree | ✅ | `known-defects`, `search` |
| Data model backfills (delivery, features, resale schedule, market, `code_norm`) | ✅ | `tests/unit/data-model.test.js`, `tests/unit/features-delivery.test.js` |
| DEL-01 flyer: one message [A7, V1], cache follows the data; sample snapshots | ✅ | `tests/router/flyer.test.js`, `tests/unit/flyer.test.js` |
| Text, Excel, search-SQL, listing helpers | ✅ | `tests/e2e.test.js` |
| Delivery truth: failed send → safety-net reply; list/blocker prompts count as replies | ✅ | `reply-delivery` |
| DEL-07 export delivered; failed delivery → error reply | ✅ | `reply-delivery` |
| Webhook batching (all messages processed; statuses ignored) | ✅ | `reply-delivery` |
| SYS-04 unregistered notice once per 24h | ✅ | `reply-delivery` |
| Graph API: no resend on timeout; 503 retried; 131047 dropped | ✅ | `tests/unit/whatsapp-client.test.js` |
| Single outbound path (no direct `WA.send*` in handlers) | ✅ | `whatsapp-client` |
| AI gateway: hedged tiers, immediate failover, route deadline, per-model thinking, telemetry, quota | ✅ | `tests/unit/ai-gateway.test.js` |
| Typing indicator on every inbound message | ✅ | `reply-delivery` |
| AI quality eval scorer | ✅ | `tests/unit/eval-score.test.js` |
| `API_CONTRACTS.json` = real exports; `SCHEMA_REFERENCE.sql` current | ✅ | `tests/contract-guard.test.js`, `tests/unit/schema-reference.test.js` |
| SYS-07 scheduler: due jobs run once across two instances, failures isolated, stale reclaim, catch-up after sleep, fixed clock | ✅ | `tests/unit/scheduler.test.js` |
| SYS-08 phone rule: 30+ spellings, kinds, display, links; broker lookups unchanged | ✅ | `tests/unit/phone.test.js` |
| Supabase Data API locked out (RLS everywhere, no API-role grants, also for later tables) | ✅ | `tests/unit/public-api-lockdown.test.js` |
| NTF-01/02 one channel per alert (chosen, fallback after a failed send, window closed, no credits, website without push), same event once (also concurrent), 2-minute merge into one grouped message, quiet hours held then released, inactive brokers skipped, /app/ URLs only | ✅ | `tests/web/notifications.test.js` |
| NTF-03 push payload = title/body/url, phones scrubbed, 410 removes the subscription; channel interface contract | ✅ | `tests/web/notifications.test.js`, `tests/unit/channels.test.js` |
| NTF-04 Telegram notifications (Release 3T): linked brokers default to Telegram (free, `tg_outbound`, no credits); chosen but unlinked → push/inbox (`not_linked`), never WhatsApp; web sign-in links on Telegram when linked; settings offer Telegram only when the bot is on | ✅ | `tests/router/telegram.test.js` |
| TG-CLIENT-01 Send on WhatsApp from Telegram: client copy and send-to-client get a wa.me URL button (long links via `/go/wa/<token>`, wa.me only); WhatsApp brokers unchanged | ✅ | `tests/router/telegram.test.js` |
| TG-CLIENT-02 Photo share page `/app/units/<code>/share-media` (navigator.share with files); photos served same-origin from our bucket only, agency-scoped | ✅ | `tests/router/telegram.test.js` |
| TG-MINIAPP-01 Website inside Telegram: initData HMAC + 1-hour auth_date + one use; only linked brokers; same-origin only; SameSite=None in the iframe; framing only by web.telegram.org | ✅ | `tests/router/telegram.test.js`, `tests/web/shell.test.js` |
| TG-SETUP-01 Boot registers webhook, menu button and commands only when token + secret + https are set | ✅ | `tests/router/telegram.test.js` |
| TG-FREE-01 Telegram searches show 10 a message (WhatsApp 5); More is one-shot (button removed from the earlier page) | ✅ | `tests/router/telegram.test.js` |
| NTF-04/05 inbox, 🔔 count, open → read + redirect, isolation between brokers, CSRF; log managers-only and agency-scoped; settings round trip | ✅ | `tests/web/notifications.test.js` |
| NTF-06/07 credit levels, hints once per level, manager alert at 80%, ceiling notice once then read ticks only, global ceiling, broker cap, sign-in ceiling, usage page = operation_logs, caps form managers-only | ✅ | `tests/web/notifications.test.js` |
| CRM-01/02 dedupe across 4 spellings and second numbers, numbers added up to 3, Q2 (managers alerted, assignee card, owner of a duplicate not messaged, no other broker), claim of an unassigned lead, erased numbers, no PII in operation_logs | ✅ | `tests/crm/leads.test.js` |
| CRM-03/06 role scoping, tenant isolation (also in the database trigger), search, filters, pages, who is calling; every lead query scoped by agency | ✅ | `tests/crm/leads.test.js` |
| CRM-04/05/07 stage rules, version conflicts, follow-ups, undo inside/after 10 minutes and after a later change, reassignment, deactivation releases leads; stage/card/authz rules | ✅ | `tests/crm/leads.test.js`, `tests/unit/lead-domain.test.js` |
| CRM-08…12 contact card new/existing (0 AI), bare number incl. a colleague's (Q2 copy only), «ليد» + text (1 AI call, fenced), lead draft + Edit + Cancel, voice = text, several phones → list, no phone → completion without another AI call, Q2 duplicate, AI down, forwards (offer, Save, Search), units and «عميل CODE» unchanged, phone inside a unit draft, buttons (Called + suggested follow-up, undo stack, stage + lost reason, old buttons, reassignment), seller → add their unit prefilled, both languages of every command, one message per turn | ✅ | `tests/router/leads.test.js` |
| CRM-13…16 web list scoping (broker, manager, other agency), search/tabs, English page, pipeline managers-only, create + merge + colleague 409, duplicate notice, validation, fill from message (typed fields kept, AI down), share target, tel/wa.me buttons, escaping, 404 across brokers and agencies, stage/follow-up/note round trips + Undo, conflict with a WhatsApp tap (409), assignment managers-only, CSRF, no-store | ✅ | `tests/web/leads.test.js` |
| CRM-17 headers in both languages, CSV (BOM, semicolons, tabs, quotes, line breaks, Windows-1256, UTF-16), `.xlsx` with a formula cell, dedupe in the file and against the database, merge fills blanks only, colleague rows untouched, erased phones flagged, nothing written before apply, second apply 409, tick required, no phone column refused, round-robin even + the broker column, one notification per assignee, 2,000 rows with progress, plan and apply isolated by broker and agency, upload rate limit, template, no names or phones in logs or the applied plan | ✅ | `tests/unit/lead-import.test.js`, `tests/web/lead-imports.test.js` |
| CRM-18 save/list/replace/remove, 3 max, empty or code-only refused, current matches recorded as new, manager adds for the lead's broker, colleague and other agency refused, hidden from saved searches; «طلب» on the open lead and by reference, voice = text, no open lead / empty / unclear / colleague's lead; web add with two places, 422 empty and fourth, remove, colleague 404 | ✅ | `tests/crm/lead-requests.test.js`, `tests/router/lead-requests.test.js`, `tests/web/leads.test.js` |
| CRM-19 web form + insert + quick update alert once, price drop / rollback / second drop, sold never, won lead quiet, grouped per broker, daily cap with matches kept, sweep ids = search ids, tenant isolation, reassigned lead | ✅ | `tests/crm/match-sweep.test.js` |
| CRM-20 saved card count across the agency + list of own + send, unit page count and Send (colleague 404), WhatsApp and web no-results → lead + request, share link carries lead_id, public page sentinels, hot once with one notification | ✅ | `tests/web/send-to-client.test.js` |
| CRM-21 10:00 default, quiet hours hold and release, grouping (5 + more), viewing unit line and place, Done/Postpone on WhatsApp and web, reassigned lead reminds the new broker, two instances remind once, nudge once (not contacted, not old), "no next step" filter | ✅ | `tests/crm/follow-up-reminders.test.js` |
| CRM-22 voice update applies every field after Confirm and Undo reverts all, typed with L- and Cancel writes nothing, two names → list → pick, unknown name → list, no client named → no AI call, past time asks again and reads both, unknown unit, colleague refused, AI down → buttons, Edit; outcome detection, names folded, normalize, checks, prompt date | ✅ | `tests/router/lead-update.test.js`, `tests/unit/lead-update.test.js` |
| CRM-23 13 reference cases and validation, Arabic ↔ English commands, review → Confirm (lead won, unit sold), split with the unit's broker, missing commission asked, Cancel, a changed unit refuses all, double tap and double submit save once, colleague refused, visibility per role (WhatsApp, service, web 404), manager corrections and conflicts, no commission in client copies | ✅ | `tests/unit/commission.test.js`, `tests/router/deals.test.js` |
| CRM-24 export contents and exclusions, 403 and 429, no-store zip; erase confirm, every CRM row gone, deal kept without client, notifications scrubbed, re-capture warns; retention and warning with a fixed clock; purge spares recent and pending, bootRecovery replays; P3 over the full flow (operation_logs, log lines, push payloads) | ✅ | `tests/crm/privacy.test.js` |
| CRM-25 every `/app/` page in English has no Arabic text and in Arabic is RTL; `?lang` signed in updates `preferred_lang`, signed out sets the cookie the sign-in page follows; offline page carries both | ✅ | `tests/web/i18n.test.js` |
| CRM-26 start link per language and bot number form, none without a number, invalid `bot_phone` refused, the script prints them on dry run; English guides exist and are linked from the runbook | ✅ | `tests/unit/onboarding.test.js`, `tests/unit/docs.test.js` |
| UNIT-CODE-01 initials (English, Arabic, one word, filler), format, prefix validation, per-agency running number across types, hand-typed code skipped, manager prefix used and checked, agencies separate; first WhatsApp draft gets AL-A1; managers only on My usage | ✅ | `tests/unit/unit-code.test.js`, `tests/router/draft-pipeline.test.js`, `tests/web/units.test.js` |
| Runbook lists every env var; manifest names every migration; broker guides present | ✅ | `tests/unit/docs.test.js` |
| XLS-01…04 WhatsApp Excel upload: acknowledgment, atomic commit, formula cells neutralised, developer sheets, rejections workbook (Arabic reasons RTL in an LTR sheet), duplicate file, cooldown, bad files; export keeps the Arabic description RTL; STATS-01 counts per agency in both languages; bootRecovery replays only fresh `new` rows, once, in order | ✅ | `tests/router/coverage-gaps.test.js` |
| DEL-03…06/08 | ⬜ | — |
| Routes never query CRM tables directly (grep guard over `routes/`, `web/routes/`, `web/views/`) | ✅ | `tests/unit/authz-registry.test.js` |

## 13. Defect IDs
Remediation-plan IDs used in test names. Each one was a `test.failing` (or a new test written with the fix) and is now a passing test.

| ID | Defect (fixed) | Release | Test |
| :--- | :--- | :--- | :--- |
| A1 | `تم` ran no AI extraction / review card | R1 step 3 | `core-flows` "A1: …" |
| A2 | Save could commit an unreviewed draft | R1 step 3 | `core-flows` "A2: …", `draft-pipeline` |
| A3 | `تعديل CODE <instructions>` ignored the instructions | R1 step 6 | `edits` "A3: …" |
| A4 | Text in edit mode was treated as a search | R1 step 6 | `core-flows`, `edits` "A4: …" |
| A5 | `تعديل سعر CODE إلى X` edited the wrong unit | R1 step 6 | `core-flows` "A5: …", `edits` |
| A7 / V1 | Two flyer pipelines; flyer sent as two messages | R1 step 7 | `flyer` |
| B1 | "More" re-ran the query (repeats and shifts) | R1 step 5 | `search` "(B1)" |
| B2 | Small talk returned random listings | R1 step 5 | `core-flows` "B2: …", `search` |
| B3 | Draft vs search collision: query lost in the button id (128-char cap) | R1 step 5 | `reply-delivery` COL-01 |
| B4 | "المزيد" inside an open draft joined the draft | R1 step 5 | `search` "(B4)" |
| B6 / B7 | Code lookup was case-sensitive and skipped the index | R1 step 5 | `search` "(B6)…(B7)" |
| C1 | English client copy contained Arabic script | R1 step 4 | `known-defects` "C1: …" |
| C2 | Client copy could contain internal data (owner, notes, commission, co-broker) | R1 step 4 | `known-defects` "C2: …" |
| C3 | Monthly rent was double-suffixed | R1 step 4 | `known-defects` "C3: …" |
| C4 | An office with 0 bedrooms showed as a studio | R1 step 4 | `known-defects` "C4: …" |
| C5 | Unknown fields showed as "-" placeholders | R1 step 4 | `known-defects` "C5: …" |
| C6 | Structured delivery and feature keys were missing from client copy | R1 step 4 | `known-defects` "C6: …" |
| C7 | Plan copy named the unit type in the wrong language | R1 step 4 | `known-defects` "C7: …" |
| D1 | Four search triggers overwrote each other and dropped features | R1 step 5 | `known-defects` "D1: …" |
| D2 | Stored and query-side Arabic normalization disagreed | R1 step 5 | `known-defects` "D2: …", `search` |
| F1 | Unknown maintenance invented as 8% | R1 step 4 | `known-defects` "F1: …" |
| F2 | Maintenance scheduled at the end of the term instead of delivery | R1 step 4 | `known-defects` "F2: …" |
| F3 | Two milestones in one period: one dropped | R1 step 4 | `known-defects` "F3: …" |
| F4 | Cash plan had empty installment rows | R1 step 4 | `known-defects` "F4: …" |
| F5 | Semi-annual installments labelled quarterly | R1 step 4 | `known-defects` "F5: …" |
| F6 | Studio described as "1 غرف نوم" | R1 step 4 | `known-defects` "F6: …" |
| F7 | Annual installments silently treated as quarterly | R1 step 4 | `known-defects` "F7: …" |
| F8 | Monthly plan compared against a quarterly budget | R1 step 4 | `known-defects` "F8: …" |
| F9 | Fractional tenure gave a fractional number of installments | R1 step 4 | `known-defects` "F9: …" |
| F10 | Unknown delivery/maintenance invented in the plan workbook and copy | R1 step 4 | `known-defects` "F10: …" |
| Q-F | Primary maintenance terms were hardcoded; now stored as data (`payment_terms.maintenance = { pct, due }`) | R1 step 4 | `known-defects` "Q-F: …" |
| U1 | Help advertised a command that did not work (`اكسل`) | R1 | `core-flows` "U1: …" |
