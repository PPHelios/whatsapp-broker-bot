# FEATURE_REGISTRY.md
## Canonical Matrix of Capabilities, Invariants & Safeguards

This registry documents every user-facing capability, command, interactive callback, and operational lifecycle handler in the AqarChat engine. Any code refactor or modification MUST preserve the behaviors, validations, and response contracts cataloged below.

---

### 1. Ingress & Media Normalization (`ING`)

| Feature ID | Event / Trigger | Pre-Conditions & Constraints | System Execution & Safeguards | Symmetrical Response Contract |
| :--- | :--- | :--- | :--- | :--- |
| **ING-01** | Photo Ingress (`type: "image"`) | - Ingress limit: Max 15 photos per unit.<br>- Ephemeral memory only. | - Normalizes buffer via Sharp: auto-rotate via EXIF, fit inside `1600x1600`, JPEG Q82.<br>- Concurrency capped at 1; RAM ceiling at 64MB.<br>- If uncompressed photo sent as document (`mime_type: "image/*"` or `.jpg/.png`), routes to image pipeline.<br>- Evaluates `draft.media_items.length`. If $>15$, additional image dropped immediately.<br>- Non-intrusive acknowledgment: Sends silent reaction (`📸`) to message bubble. | **Success (<15):** Emits silent WhatsApp emoji reaction (`📸`) on photo bubble without disruptive text notifications.<br>**Warning (>15):** "⚠️ تم الوصول للحد الأقصى المسموح به (15 صورة) للوحدة. تم تجاهل الصور الزائدة." accompanied by `[Done (Save) ✅]` / `[Cancel ❌]` buttons to prevent conversational dead ends. |
| **ING-02** | Voice Note Ingress (`type: "voice" / "audio"`) | - Ingress limit: $\le 120\text{s}$ for draft/edit; $\le 45\text{s}$ for search.<br>- OGG/Opus clean MIME. | - If active draft/edit session exists: appends buffer to session array in `broker_sessions`.<br>- If no active session: transcribes buffer via Gemini Audio for property search.<br>- If search audio $>45\text{s}$: rejects audio before calling AI. | **Draft Active:** "🎙️ تم استلام الملاحظة الصوتية وإضافتها للمسودة. اكتب *«تم»* عند الانتهاء." with `[Done (Save) ✅]` / `[Cancel ❌]` buttons.<br>**Audio Over Limit:** "⚠️ تسجيل البحث طويل (الحد الأقصى 45 ثانية)." |
| **ING-03** | Multiple Voice Processing | - Broker sends 2 or more voice notes during draft or edit. | - Audio buffers stored sequentially in `broker_sessions`.<br>- Commit phase passes all voice buffers as concurrent `inlineData` parts in a single multimodal Gemini call. | Synthesizes specs across all recordings into a single coherent review card. |
| **ING-04** | Explicit Unit Code Parsing | - Message contains `#`, `code:`, `كود:`, `الكود:`, `كود الوحدة:`, `الكود الداخلي:`. | - Converts Eastern Arabic digits (`٠-٩`) to Western digits.<br>- Enforces alphanumeric `^[A-Za-z0-9_\-\.\/]{2,30}$`.<br>- Rejects Arabic text (`invalidArabic: true`).<br>- Checks DB uniqueness within `agency_id`. | **Valid:** Sets draft code or returns unit details card.<br>**Arabic Error:** "⚠️ كود الوحدة يجب أن يتكون من حروف إنجليزية وأرقام فقط (مثال: #HAS577)."<br>**Conflict:** "⚠️ الكود مستخدم بالفعل لوحدة أخرى." |
| **ING-05** | Image-Only Draft Blocker | - Broker triggers `تم` / `save` on a draft containing photos only. | - Checks `textCount === 0 && voiceCount === 0`.<br>- Blocks draft finalization; preserves images in `broker_sessions`. | "⚠️ لا يمكن تسجيل الوحدة بالصور فقط. يرجى إرسال فويس نوت أو رسالة تحتوي على السعر والمشروع." with `[Done (Save) ✅]` / `[Cancel ❌]` buttons. |
| **ING-06** | Unsupported Media Types | - Inbound message contains `location`, `video`, or `contacts`. | - Evaluates `switch(message.type)` default branches.<br>- Prevents silent drop by dispatching guidance bubble. | Returns explicit guidance bubble informing broker that location pins, video files, and contact cards must be entered as text or voice notes. |

---

### 2. Bulk Excel Inventory Ingestion (`XLS`)

| Feature ID | Event / Trigger | Pre-Conditions & Constraints | System Execution & Safeguards | Symmetrical Response Contract |
| :--- | :--- | :--- | :--- | :--- |
| **XLS-01** | Excel Document Ingress | - File extension must be `.xlsx`.<br>- File size $\le 5\text{MB}$.<br>- Valid magic bytes (`PK\x03\x04`). | - Downloads file buffer into memory (no `/tmp` disk writes).<br>- Sanitizes dangerous formula execution characters (`=`, `+`, `-`, `@`, `\t`, `\r`) via `Excel.sanitizeCellValue`.<br>- Dynamic multi-column header mapping.<br>- Runs pre-flight dry-run validation in memory. | **Immediate Acknowledgment:** "📥 تم استلام ملف المخزون... الوقت المتوقع: 10 إلى 15 ثانية." |
| **XLS-02** | Atomic Batch Commit & Developer Protection | - Minimum 1 valid row.<br>- Scoped to `agency_id`. | - Wraps valid rows in single database transaction under 64-bit advisory lock `pg_advisory_xact_lock(hashtext($1), hashtext('bulk_import'))`.<br>- Automatically flags developer project sheets as `inventory_type = 'developer_model'` and `is_primary_developer = true`.<br>- Harmonizes typologies (studios 0 beds, villas BUA/land area).<br>- Updates GIN trigrams and wipes `flyer_cache`. | Written directly to `listings` table. |
| **XLS-03** | Status & Rejection Reporting | - Bulk import completed. | - Checks `rejectedRows.length`.<br>- If $>0$, compiles in-memory `مرفوضات_<filename>.xlsx` via `Excel.buildRejectionWorkbook` with highlighted row diagnostics.<br>- Distributed 45s cooldown recorded in `broker_sessions`. | **Zero Rejections:** "✅ تم استيراد المخزون بنجاح: تم حفظ وتحديث X وحدة."<br>**With Rejections:** Dispatches text summary breakdown followed by the `.xlsx` rejection document. Cooldown released immediately on crash. |
| **XLS-04** | Layout & RTL Reading Order | - Generated export / rejection workbooks. | - Overall sheet layout locked to English LTR.<br>- Columns for Arabic description and summary explicitly set to RTL reading order (`alignment: { readingOrder: 'rtl' }`). | Professional dual-language workbook delivery. |

---

### 3. Draft State Machine & Creation Lifecycle (`DRF`)

| Feature ID | Event / Trigger | Pre-Conditions & Constraints | System Execution & Safeguards | Symmetrical Response Contract |
| :--- | :--- | :--- | :--- | :--- |
| **DRF-01** | Open Draft (`اضافة`, `add`, `new`) | - Broker is active and authorized. | - Checks/clears existing draft in `broker_sessions`.<br>- Sets 15-minute sliding TTL (`expires_at = NOW() + INTERVAL '15 minutes'`). | "📝 تم فتح مسودة وحدة جديدة. أرسل الصور، التسجيلات الصوتية، أو التفاصيل واكتب «تم» عند الانتهاء." |
| **DRF-02** | Pre-Save Validation Review (`تم`, `حفظ`, `done`) | - Active draft session exists in `broker_sessions`. | - Calls Gemini extraction cascade with audio/text parts.<br>- Evaluates Hard Blockers: Price, Area, Compound.<br>- Studios: Validates 0 bedrooms without triggering blocker.<br>- Villas: Floor suppressed; BUA/land area elevated.<br>- Reconciles resale balance: `Total Asking Price = Upfront Cash + Remaining Developer Debt`.<br>- Attaches `deltaWarning` if discrepancy $>100$ EGP. | **Missing Blockers:** Lists missing items in bullet points.<br>**Complete:** Displays pre-save card with `[تأكيد وحفظ ✅]`, `[تعديل ✏️]` (`draft_edit`), `[إلغاء ❌]`. |
| **DRF-03** | Commit Finalization (`draft_confirm` / `DRAFT_SAVE`) | - Active draft in `broker_sessions`.<br>- Broker authorized. | - Invokes `Drafts.commitDraftToDatabase`.<br>- Acquires 64-bit advisory lock on `(agency_id, code)`.<br>- Atomic draft consumption (`DELETE ... RETURNING session_data`) to prevent double-tap race conditions.<br>- Commits physical columns (`bathrooms`, `bedrooms`, `price_value`, `area_value`) and JSONB details.<br>- Streams images to Supabase storage (`role = NULL`). | Symmetrical confirmation card echoing monospace unit code, accompanied by forwardable client ad copy. |
| **DRF-04** | Draft Inactivity Expiration | - No incoming messages for $>15$ minutes. | - Evaluated at message arrival or background sweep.<br>- Clears expired draft session from `broker_sessions`. | "⏳ انتهت صلاحية المسودة (15 دقيقة بدون نشاط). يرجى بدء إضافة جديدة بإرسال الصور أو المواصفات." |
| **DRF-05** | Discard Draft (`الغاء`, `cancel`, `DRAFT_CANCEL`) | - Active draft session exists. | - Purges session row from `broker_sessions`.<br>- Clears uncommitted image references. | "🗑️ تم إلغاء المسودة وتفريغ البيانات بنجاح." |
| **DRF-06** | Replace Media (`استبدال`, `replace`) | - Active draft session exists. | - Empties stored photo buffer array in `broker_sessions`.<br>- Retains recorded text notes and voice notes. | "🔄 تم مسح الصور السابقة من المسودة. أرسل الصور الجديدة الآن." |

---

### 4. Interactive Editing Engine (`EDT`)

| Feature ID | Event / Trigger | Pre-Conditions & Constraints | System Execution & Safeguards | Symmetrical Response Contract |
| :--- | :--- | :--- | :--- | :--- |
| **EDT-01** | One-Shot Patch (`تعديل <CODE> <INSTRUCTIONS>`) | - `canEdit(broker, listing)` is true. | - Gemini (temp 0) parses instructions against current unit JSON.<br>- Stages patch in `broker_sessions`. | "✏️ جاري تنفيذ تعليمات التعديل للوحدة #[CODE]..." |
| **EDT-02** | Multi-Turn Edit Session (`تعديل <CODE>` alone, or `edit:<CODE>` button) | - `canEdit(broker, listing)` is true. | - Opens dedicated edit mode in `broker_sessions` with 15-minute sliding TTL.<br>- Intercepts and accumulates follow-up audio, photos, and text.<br>- Finalizes upon receiving `تم`. | "✏️ وضع التعديل نشط للوحدة #[CODE]. أرسل تعديلاتك (صوت أو كتابة) واكتب «تم» عند الانتهاء." |
| **EDT-03** | Direct Inline Attribute Patch (`سعر <CODE> إلى <VAL>`) | - Resale inventory only.<br>- Valid numeric price extracted via `parseEgyptianPrice(raw).priceValue`. | - Distributed 64-bit advisory lock acquired.<br>- Updates `price_value`, recalculates cash requirements, updates GIN trigrams, wipes `flyer_cache`. | "✅ تم تعديل سعر الوحدة #[CODE] إلى [VAL]. تم تحديث فهارس البحث ومسح كاش البروشور القديم." |
| **EDT-04** | Developer Price Guard | - Unit is marked `is_primary_developer = true` or `inventory_type = 'developer_model'`. | - Intercepts direct price mutation attempts.<br>- Blocks inline price edits to prevent corrupting certified payment matrices. | "⚠️ لا يمكن تعديل أسعار مشاريع المطورين مباشرة لارتباطها بجدول أقساط معتمد. يرجى رفع شيت الأسعار المحدث." |
| **EDT-05** | Mutation Cascade Execution | - Any attribute patch committed (price, finishing, area, bedrooms). | - Updates primary DB column.<br>- Re-synthesizes Arabic (`title`) and English (`title_en`) titles.<br>- Re-runs `clean_arabic_text` to update `search_text_normalized`.<br>- Purges `flyer_cache = '{}'::jsonb`.<br>- Preserves `listing_images` role curation. | Refreshes listing and presents updated unit preview card. |

---

### 5. Unit Lifecycle & Permanent Deletion (`LFC` / `DEL`)

| Feature ID | Event / Trigger | Pre-Conditions & Constraints | System Execution & Safeguards | Symmetrical Response Contract |
| :--- | :--- | :--- | :--- | :--- |
| **DEL-01** | Delete Request (`حذف <CODE>`, `delete`) | - `canEdit(broker, listing)` is true. | - Acquires 64-bit advisory lock and row lock (`FOR UPDATE`).<br>- Verifies ownership/admin role.<br>- Constructs confirmation dialog with distinct cancel ID `del_cancel:<CODE>`. | Dispatches warning prompt with buttons $\le 20$ chars: `[Delete 🗑️ / تأكيد الحذف 🗑️]` / `[Cancel ❌ / تراجع ❌]`. |
| **DEL-02** | Confirm Deletion (`del_confirm:<ID>:<CODE>`) | - Triggered via interactive button tap. | - Executes inside 64-bit transactional advisory lock.<br>- Collects all image paths from `listing_images` and `flyer_cache`.<br>- Executes `DELETE FROM listings WHERE id = $1` (cascading images).<br>- Dispatches asynchronous, non-blocking `deleteStorageFiles` to Supabase Storage. | "🗑️ تم حذف الوحدة #[CODE] نهائياً ومسح كافة وسائطها وملفاتها من السيرفر." |
| **LFC-01** | Mark as Sold (`تم البيع`, `sold <CODE>`) | - Unit must be `active`. | - Row-locked status update: `status = 'sold'`.<br>- Hides unit from general search queries.<br>- Purges `flyer_cache`. | "✅ تم تغيير حالة الوحدة #[CODE] إلى: *تم البيع*." |
| **LFC-02** | Archive Listing (`أرشفة`, `archive <CODE>`) | - Unit must be `active`. | - Row-locked status update: `status = 'archived'`.<br>- Hides unit from search.<br>- Purges `flyer_cache`. | "✅ تم تغيير حالة الوحدة #[CODE] إلى: *مؤرشفة ومخفية من البحث*." |
| **LFC-03** | Reactivate Listing (`تفعيل`, `active <CODE>`) | - Unit is `sold` or `archived`. | - Row-locked status update: `status = 'active'`.<br>- Restores search index visibility.<br>- Refreshes `updated_at`. | "✅ تم تغيير حالة الوحدة #[CODE] إلى: *نشطة ومتاحة في البحث*." |

---

### 6. Search & Collision Management (`SCH` / `COL`)

| Feature ID | Event / Trigger | Pre-Conditions & Constraints | System Execution & Safeguards | Symmetrical Response Contract |
| :--- | :--- | :--- | :--- | :--- |
| **SCH-01** | Multimodal Search Query | - Text or transcribed voice note.<br>- No active draft/edit session open. | - AI gateway route `search_parse`: hedged Gemini tiers, 8s deadline, fast thinking per model.<br>- Deterministic regex fallback (`fallbackParse`) on any AI failure or deadline.<br>- Hard bathroom filtering against physical column `listings.bathrooms`.<br>- Non-negative integer parsing (`nonNegInt`) allows 0-bedroom studio searches.<br>- **Pass 1 (Strict):** Queries `search_text_normalized` using GIN trigrams and boundary constraints.<br>- **Pass 2 (Relaxed):** If Pass 1 returns 0, auto-widens price/area by $\pm 15\%$ and bedrooms by $\pm 1$, but keeps compound strictly locked. | Streams up to 5 matching unit cards with defensive window count.<br>If Pass 2: prepends close alternative alert. If zero matches: returns helpful guidance with widening suggestions. |
| **SCH-02** | Search Pagination (`MORE_SEARCH` / `المزيد`) | - Active search state in `broker_sessions` (`session_type = 'search_state'`). | - Reads stored query filters, offset, and total count from PostgreSQL.<br>- Fetches next page (`LIMIT 5 OFFSET offset`).<br>- Updates cursor in `broker_sessions`. | Streams next 5 unit cards with `[المزيد ➡️]` button or confirms end of matching results. |
| **COL-01** | Draft vs. Search Collision | - Broker sends text/audio with explicit search keywords (`عايز`, `ابحث`, etc.) while a draft is open. | - Intercepts query; detects search intent (property type words alone do not trigger collision).<br>- Stores the query server-side in `broker_sessions` (`pending_search`, 15-min TTL).<br>- Halts automatic draft append. | "⚠️ لديك مسودة وحدة قيد الإضافة حالياً. هل تريد إلغاء المسودة والبحث في المخزون بدلاً من ذلك؟"<br>Buttons: `[🔍 إلغاء والبحث]` (`cancel_and_search`) / `[📝 إكمال المسودة]` (`draft_edit`). Tapping search runs the full stored query; legacy `cancel_and_search:<b64>` ids still work. |

---

### 7. Deliverables & Marketing Outputs (`DEL`)

| Feature ID | Event / Trigger | Pre-Conditions & Constraints | System Execution & Safeguards | Symmetrical Response Contract |
| :--- | :--- | :--- | :--- | :--- |
| **DEL-01** | Luxury Brochure Curation & Render (`flyer:lang:theme:CODE` / `كتالوج <CODE>`) | - Brochure requested.<br>- 20s distributed cooldown in `broker_sessions`. | - Lazy Vision Curation: Checks `listing_images` for uncurated photos (`role IS NULL`).<br>- Generates 768px in-memory thumbnails.<br>- 1 Gemini Vision call classifies roles, selects hero facade (strictly excluding bathrooms/documents), and enforces diversity quotas.<br>- Persists curated order to `listing_images` and `listings.details`.<br>- Satori/Sharp generates English LTR flyer.<br>- Caches result in `flyer_cache`. | Immediate status message with dynamic median ETA, followed by luxury flyer image delivery. |
| **DEL-02** | Client Ad Copy (`عميل <CODE>` / `client <CODE>`) | - Unit exists in `listings`. | - Typology-Aware Layout:<br>  * Villas/Townhouses: Suppresses floor; displays BUA, Land Area, Garden, and Roof.<br>  * Studios: Formats open-concept studio cleanly.<br>- Arabic (`عميل`): Standard broker terminology, owner equity vs. developer debt.<br>- English (`client`): Executive LTR format.<br>- Zero system metadata or technical notes. | Forwardable WhatsApp ad copy bubble with broker signature. |
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
| **SYS-04** | Unregistered Number | - Sender has no active broker row. | - Message is still recorded in `inbound_messages`.<br>- Notice is sent at most once per 24h per number. | Bilingual "number not registered, ask your agency admin" notice, once per 24h. |
| **SEC-01** | Webhook Cryptographic Verification | - Inbound HTTP POST to `/webhook`. | - Validates Meta's `X-Hub-Signature-256` HMAC-SHA256 signature against `WHATSAPP_APP_SECRET` using `crypto.timingSafeEqual`. | **Invalid:** HTTP 401 Unauthorized.<br>**Valid:** Proceeds to payload ingestion. |
| **SEC-02** | Row-Level Tenant Isolation | - Every SQL query across all modules. | - Enforces `WHERE agency_id = $1` on all SELECT, UPDATE, and DELETE statements.<br>- Cross-agency data access is structurally impossible. | Absolute multi-tenant segregation. |
| **SEC-03** | Startup Crash Recovery & Webhook Deduplication | - Server process boot (`bootRecovery()`) and webhook ingress. | - Ingress inserts `msg_id` into `inbound_messages` (`ON CONFLICT DO NOTHING`) to eliminate duplicate deliveries.<br>- Boot sweep recovers unhandled records (`status = 'new'`) from last 15 mins using `FOR UPDATE SKIP LOCKED`. | Prevents message loss across Render restarts or container cycling. |
| **SEC-04** | Distributed Multi-Pod Session Persistence | - All transient state, drafts, edits, search pagination, and cooldowns. | - Persisted in PostgreSQL `broker_sessions` table (`session_type IN ('draft', 'edit', 'search_state', 'session_context', 'cooldown_*')`).<br>- Zero reliance on Node.js process memory (`new Map()`). | Eliminates state amnesia across Render cold boots, free-tier idling, and blue/green deployment crossovers. |

---

## 10. QA Test Verification & Traceability Baseline

* `TC-ING-01`: 1–15 photos processed into in-memory buffer; sharp resized to 1600x1600 Q82; silent WhatsApp reaction (`📸`) emitted; zero text bubbles dispatched.
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
## 11. Test Coverage Map
Legend: ✅ covered by a passing test · 🐞 known defect pinned as `test.failing` (plan ID in brackets) · ⬜ not yet covered.
Router tests send real webhook payloads through the production pipeline (`tests/router/`); unit tests live in `tests/unit/` and `tests/e2e.test.js`.

| Feature / TC | Status | Test |
| :--- | :--- | :--- |
| SEC-01 / TC-SEC-01 signature verification | ✅ | `tests/router/webhook-security.test.js` |
| SEC-02 / TC-SEC-02 tenant isolation (lookup, search) | ✅ | `tests/router/core-flows.test.js` |
| SEC-03 webhook dedup + completed status | ✅ | `core-flows` |
| SEC-03 crash recovery (`bootRecovery`) | ⬜ | — (plan P0 #3) |
| TC-SEC-03 drain returns 503 | ✅ | `webhook-security` |
| SYS-01 help / SYS-02 language toggle | ✅ | `core-flows` |
| ING-01 / TC-ING-01 photo stored + 📸 reaction | ✅ | `core-flows` |
| ING-01 photo must not also send the fallback bubble | ✅ | `core-flows` |
| TC-ING-02 16th photo warning with Save/Cancel | ✅ | `tests/router/reply-delivery.test.js` |
| ING-05 / TC-ING-04 image-only draft blocked | ✅ | `core-flows` |
| ING-06 / TC-ING-05 unsupported media guidance | ✅ (video) | `core-flows` |
| DRF-01 open draft · DRF-05 cancel · text append | ✅ | `core-flows` |
| DRF-02 AI extraction + review card | 🐞 [A1] | `core-flows` |
| DRF-03 commit only a reviewed draft | 🐞 [A2] | `core-flows` |
| ING-04 `#CODE` unit card | ✅ | `core-flows` |
| DEL-01/02 delete with confirmation; owner-only | ✅ | `core-flows` |
| DEL-01 delete prompt without fallback bubble | ✅ | `core-flows` |
| LFC-01 mark sold | ✅ | `core-flows` |
| EDT-03 / TC-EDT-01 inline price edit | ✅ | `core-flows` |
| EDT-04 / TC-EDT-02 developer price guard | ✅ | `core-flows` |
| EDT-01 `تعديل CODE <instructions>` / prefixed price form | 🐞 [A3, A5] | `core-flows` (A5) |
| EDT-02 multi-turn edit session | 🐞 [A4] | `core-flows` |
| SCH-01 search, agency-scoped; AI outage → regex fallback | ✅ | `core-flows` |
| SCH-01 small talk is not a search | 🐞 [B2] | `core-flows` |
| SCH-02 / TC-SCH-03 pagination | ⬜ | — (plan B1) |
| DEL-02 client copy uses the agency's own code | ✅ | `core-flows`, `tests/unit/known-defects.test.js` |
| SYS-01 help lists only working commands | 🐞 [U1] | `core-flows` |
| Financial schedules (DEL-04/05) | ✅ baseline · 🐞 [F1–F6, F8] | `tests/unit/known-defects.test.js`, `tests/e2e.test.js` |
| Client copy language/format | 🐞 [C1, C3, C4] | `tests/unit/known-defects.test.js` |
| DB search-text triggers / normalization | 🐞 [D1, D2] | `tests/unit/known-defects.test.js` |
| Text, Excel, search-SQL, listing helpers | ✅ | `tests/e2e.test.js` |
| Delivery truth: failed send → safety-net reply; list/blocker prompts count as replies | ✅ | `reply-delivery` |
| DEL-07 export delivered; failed delivery → error reply | ✅ | `reply-delivery` |
| Webhook batching (all messages processed; statuses ignored) | ✅ | `reply-delivery` |
| SYS-04 unregistered notice once per 24h | ✅ | `reply-delivery` |
| COL-01 long query round trip + legacy buttons | ✅ | `reply-delivery` |
| Graph API: no resend on timeout; 503 retried; 131047 dropped | ✅ | `tests/unit/whatsapp-client.test.js` |
| Single outbound path (no direct `WA.send*` in handlers) | ✅ | `whatsapp-client` |
| AI gateway: hedged tiers, immediate failover, route deadline, per-model thinking, success+failure telemetry | ✅ | `tests/unit/ai-gateway.test.js` |
| Typing indicator on every inbound message | ✅ | `reply-delivery` |
| AI quality eval scorer | ✅ | `tests/unit/eval-score.test.js` |
| XLS-01…04, DEL-01 flyer, DEL-03…06/08, STATS-01 | ⬜ | — (added with their remediation batches) |
