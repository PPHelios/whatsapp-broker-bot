# FEATURE_REGISTRY.md
## Canonical Matrix of Capabilities, Invariants & Safeguards

This registry documents every user-facing capability, command, interactive callback, and operational lifecycle handler in the AqarChat engine. Any code refactor or modification MUST preserve the behaviors, validations, and response contracts cataloged below.

---

### 1. Ingress & Media Normalization (`ING`)

| Feature ID | Event / Trigger | Pre-Conditions & Constraints | System Execution & Safeguards | Symmetrical Response Contract |
| :--- | :--- | :--- | :--- | :--- |
| **ING-01** | Photo Ingress (`type: "image"`) | - Ingress limit: Max 15 photos per unit.<br>- Ephemeral memory only. | - Normalizes buffer via Sharp: rotate, fit inside `1600x1600`, JPEG Q82.<br>- Concurrency capped at 1; RAM ceiling at 64MB.<br>- Evaluates `draft.media_items.length`. If $>15$, extra image is dropped immediately. | **Success (<15):** Appends to draft; returns draft confirmation with Save/Cancel buttons.<br>**Warning (>15):** "⚠️ تم الوصول للحد الأقصى المسموح به (15 صورة) للوحدة. تم تجاهل الصور الزائدة." accompanied by `[Done (Save) ✅]` / `[Cancel ❌]` buttons to prevent conversational dead ends. |
| **ING-02** | Voice Note Ingress (`type: "voice" / "audio"`) | - Ingress limit: $\le 120\text{s}$ for draft/edit; $\le 45\text{s}$ for search.<br>- OGG/Opus clean MIME. | - If active draft/edit session exists: appends buffer to session array.<br>- If no active session: transcribes buffer via Gemini Audio for property search.<br>- If search audio $>45\text{s}$: rejects audio before calling AI. | **Draft Active:** "🎙️ تم استلام الملاحظة الصوتية وإضافتها للمسودة. اكتب *«تم»* عند الانتهاء." with `[Done (Save) ✅]` / `[Cancel ❌]` buttons.<br>**Audio Over Limit:** "⚠️ تسجيل البحث طويل (الحد الأقصى 45 ثانية)." |
| **ING-03** | Multiple Voice Processing | - Broker sends 2 or more voice notes during draft or edit. | - Audio buffers stored sequentially in session array.<br>- Commit phase passes all voice buffers as concurrent `inlineData` parts in a single multimodal Gemini call. | Synthesizes specs across all recordings into a single coherent review card. |
| **ING-04** | Explicit Unit Code Parsing | - Line starts with `#`, `code:`, `كود:`, `الكود:`. | - Converts Eastern Arabic digits (`٠-٩`) to Western digits.<br>- Enforces alphanumeric `^[A-Za-z0-9_-]{3,30}$`.<br>- Rejects Arabic text (`invalidArabic: true`).<br>- Checks DB uniqueness within `agency_id`. | **Valid:** Sets draft code.<br>**Arabic Error:** "⚠️ كود الوحدة يجب أن يتكون من حروف إنجليزية وأرقام فقط (مثال: #HAS577)."<br>**Conflict:** "⚠️ الكود مستخدم بالفعل لوحدة أخرى." |
| **ING-05** | Image-Only Draft Blocker | - Broker triggers `تم` / `save` on a draft containing photos only. | - Checks `textCount === 0 && voiceCount === 0`.<br>- Blocks draft finalization; preserves images in session. | "⚠️ لا يمكن تسجيل الوحدة بالصور فقط. يرجى إرسال فويس نوت أو رسالة تحتوي على السعر والموقع، ثم اضغط حفظ." with `[Done (Save) ✅]` / `[Cancel ❌]` buttons. |
| **ING-06** | Unsupported Media Types | - Inbound message contains `location`, `video`, `contacts`, or `document` (non-Excel). | - Evaluates `switch(message.type)` default branches.<br>- Prevents silent termination. | Returns explicit guidance bubble informing broker of supported media formats. |

---

### 2. Bulk Excel Inventory Ingestion (`XLS`)

| Feature ID | Event / Trigger | Pre-Conditions & Constraints | System Execution & Safeguards | Symmetrical Response Contract |
| :--- | :--- | :--- | :--- | :--- |
| **XLS-01** | Excel Document Ingress | - File extension must be `.xlsx`.<br>- File size $\le 5\text{MB}$.<br>- Valid magic bytes (`PK\x03\x04`). | - Downloads file buffer into memory (no `/tmp` disk writes).<br>- Sanitizes dangerous formula execution characters (`=`, `+`, `-`, `@`, `\t`, `\r`) via `Excel.sanitizeCellValue`.<br>- Runs pre-flight dry-run validation in memory.<br>- Auto-generates unit codes if missing. | **Immediate Acknowledgment:** "📥 تم استلام ملف المخزون... الوقت المتوقع: 10 إلى 15 ثانية." |
| **XLS-02** | Atomic Batch Commit | - Minimum 1 valid row.<br>- Scoped to `agency_id`. | - Wraps valid rows in single database transaction (`withTransaction`) under a 64-bit advisory lock.<br>- Inserts units, updates GIN trigram normalized search columns, and wipes `flyer_cache`. | Written directly to `listings` table. |
| **XLS-03** | Status & Rejection Reporting | - Bulk import completed. | - Checks `rejectedRows.length`.<br>- If $>0$, compiles in-memory `مرفوضات_<filename>.xlsx` via `Excel.buildRejectionWorkbook` with color-coded row diagnostics. | **Zero Rejections:** "✅ تم استيراد المخزون بنجاح: تم حفظ وتحديث X وحدة."<br>**With Rejections:** Dispatches text summary breakdown followed by the `.xlsx` rejection document. Cooldown is released immediately on failure. |
| **XLS-04** | Layout & RTL Reading Order | - Generated export / rejection workbooks. | - Overall sheet layout locked to English LTR.<br>- Columns for Arabic description and summary explicitly set to RTL reading order (`alignment: { readingOrder: 'rtl' }`). | Professional dual-language workbook delivery. |

---

### 3. Draft State Machine & Creation Lifecycle (`DRF`)

| Feature ID | Event / Trigger | Pre-Conditions & Constraints | System Execution & Safeguards | Symmetrical Response Contract |
| :--- | :--- | :--- | :--- | :--- |
| **DRF-01** | Open Draft (`اضافة`, `add`, `new`) | - Broker is active and authorized. | - Checks/clears existing draft in `broker_sessions`.<br>- Sets 15-minute sliding TTL (`expires_at = NOW() + INTERVAL '15 minutes'`). | "📝 تم فتح مسودة وحدة جديدة. أرسل الصور، التسجيلات الصوتية، أو التفاصيل واكتب «تم» عند الانتهاء." |
| **DRF-02** | Pre-Save Validation Review (`تم`, `حفظ`, `done`) | - Active draft session exists in `broker_sessions`. | - Calls Gemini extraction cascade with audio/text parts.<br>- Evaluates Hard Blockers: Code, Price, Area, Compound/Location, Property Type.<br>- If Blockers Missing: Halts save; lists missing fields.<br>- If Valid: Elevates bathrooms, floor, nanny room; renders interactive review card. | **Missing Blockers:** Lists missing items in red bullet points.<br>**Complete:** Displays pre-save card with `[تأكيد وحفظ ✅]`, `[تعديل ✏️]` (`DRAFT_EDIT`), `[إلغاء ❌]`. |
**DRF-03** | Commit Finalization (`DRAFT_SAVE` / `draft_confirm`) | - Active draft in `broker_sessions`.<br>- Contains valid specs and/or voice buffers.<br>- Broker authorized. | - Invokes `Drafts.commitDraftToDatabase(broker, draft, ctx)`.<br>- Acquires 64-bit distributed advisory lock on `(agency_id, code)`.<br>- Commits row to `listings` with functional trigram search vector.<br>- Streams images to Supabase storage and persists in `listing_images` (`role = NULL`).<br>- Purges session from `broker_sessions`. | Symmetrical confirmation card echoing monospace unit code, accompanied by forwardable client ad copy. |

| **DRF-04** | Draft Inactivity Expiration | - No incoming messages for $>15$ minutes. | - Checked at message arrival or background sweep.<br>- Clears expired draft session from PostgreSQL. | "⏳ انتهت صلاحية الجلسة لمرور 15 دقيقة بدون نشاط. تم تفريغ المسودة تلقائياً لحماية البيانات." |
| **DRF-05** | Discard Draft (`الغاء`, `cancel`, `DRAFT_CANCEL`) | - Active draft session exists. | - Purges session row from `broker_sessions`.<br>- Clears uncommitted image references. | "🗑️ تم إلغاء المسودة بنجاح." |
| **DRF-06** | Replace Media (`استبدال`, `replace`) | - Active draft session exists. | - Empties stored photo buffer array in `broker_sessions`.<br>- Retains recorded text notes and voice notes. | "🔄 تم مسح الصور السابقة من المسودة. أرسل الصور الجديدة الآن." |

---

### 4. Interactive Editing Engine (`EDT`)

| Feature ID | Event / Trigger | Pre-Conditions & Constraints | System Execution & Safeguards | Symmetrical Response Contract |
| :--- | :--- | :--- | :--- | :--- |
| **EDT-01** | One-Shot Patch (`تعديل <CODE> <INSTRUCTIONS>`) | - `canEdit(broker, listing)` is true. | - Gemini (temp 0) parses instructions against current unit JSON.<br>- Computes strikethrough diff card (e.g. `• السعر: ~15M~ ⬅️ *18M*`).<br>- Stages patch in `broker_sessions`. | Displays diff preview card with `[✅ تأكيد وحفظ]`, `[✏️ تعديل إضافي]`, `[❌ تراجع]`. |
| **EDT-02** | Multi-Turn Edit Session (`تعديل <CODE>` alone) | - `canEdit(broker, listing)` is true. | - Opens dedicated edit mode in `broker_sessions` with 15-minute sliding TTL.<br>- Intercepts and accumulates follow-up audio, photos, and text.<br>- Finalizes upon receiving `تم` or `EDIT_SAVE`. | "✏️ وضع التعديل نشط للوحدة #[CODE]. أرسل تعديلاتك (صوت أو كتابة) واكتب «تم» عند الانتهاء." |
| **EDT-03** | Direct Inline Attribute Patch (`سعر <CODE> إلى <VAL>`) | - Resale inventory only.<br>- Valid numeric price extracted via `parseEgyptianPrice(raw).priceValue`. | - Distributed 64-bit advisory lock acquired.<br>- Updates `price_value`, recalculates cash requirements, updates GIN trigrams, wipes `flyer_cache`. | "✅ تم تعديل سعر الوحدة #[CODE] إلى [VAL]. تم تحديث فهارس البحث ومسح كاش البروشور." |
| **EDT-04** | Developer Price Guard | - Unit is marked `is_primary_developer = true` or `developer_model`. | - Intercepts direct price mutation attempts.<br>- Blocks inline price edits to prevent corrupting staged installment matrices. | "⚠️ لا يمكن تعديل أسعار مشاريع المطورين مباشرة لارتباطها بجدول أقساط معتمد. يرجى رفع شيت الأسعار المحدث." |
| **EDT-05** | Mutation Cascade Execution | - Any attribute patch committed (price, finishing, area, bedrooms). | - Updates primary DB column.<br>- Re-synthesizes Arabic (`title`) and English (`title_en`) titles.<br>- Re-runs `clean_arabic_text` to update `search_text_normalized`.<br>- Purges `flyer_cache = '{}'::jsonb`.<br>- Preserves `listing_images` role curation. | Refreshes listing and presents updated unit preview card. |

---

### 5. Unit Lifecycle & Permanent Deletion (`LFC` / `DEL`)

| Feature ID | Event / Trigger | Pre-Conditions & Constraints | System Execution & Safeguards | Symmetrical Response Contract |
| :--- | :--- | :--- | :--- | :--- |
| **DEL-01** | Delete Request (`حذف <CODE>`, `delete`) | - `canEdit(broker, listing)` is true. | - Acquires 64-bit advisory lock and row lock (`FOR UPDATE`).<br>- Verifies ownership/admin role.<br>- Constructs confirmation dialog with distinct cancel ID `del_cancel:<CODE>`. | Dispatches warning prompt with buttons $\le 20$ chars: `[Delete 🗑️ / تأكيد الحذف 🗑️]` / `[Cancel ❌ / تراجع ❌]`. |
| **DEL-02** | Confirm Deletion (`del_confirm:<ID>:<CODE>`) | - Triggered via interactive button tap. | - Executes inside 64-bit transactional advisory lock.<br>- Collects all image paths from `listing_images` and `flyer_cache`.<br>- Executes `DELETE FROM listings WHERE id = $1` (cascades image rows).<br>- Dispatches asynchronous, non-blocking `deleteStorageFiles` to Supabase Storage. | "🗑️ تم حذف الوحدة #[CODE] نهائياً ومسح كافة وسائطها وملفاتها من السيرفر." |
| **LFC-01** | Mark as Sold (`تم البيع`, `sold <CODE>`) | - Unit must be `active`. | - Row-locked status update: `status = 'sold'`.<br>- Hides unit from general search queries.<br>- Purges `flyer_cache`. | "✅ أصبحت حالة الوحدة #[CODE]: *تم البيع*." |
| **LFC-02** | Archive Listing (`أرشفة`, `archive <CODE>`) | - Unit must be `active`. | - Row-locked status update: `status = 'archived'`.<br>- Hides unit from search.<br>- Purges `flyer_cache`. | "✅ أصبحت حالة الوحدة #[CODE]: *مؤرشفة ومخفية من البحث*." |
| **LFC-03** | Reactivate Listing (`تفعيل`, `active <CODE>`) | - Unit is `sold` or `archived`. | - Row-locked status update: `status = 'active'`.<br>- Restores search index visibility.<br>- Refreshes `updated_at`. | "✅ أصبحت حالة الوحدة #[CODE]: *نشطة ومتاحة في البحث*." |

---

### 6. Search & Collision Management (`SCH` / `COL`)

| Feature ID | Event / Trigger | Pre-Conditions & Constraints | System Execution & Safeguards | Symmetrical Response Contract |
| :--- | :--- | :--- | :--- | :--- |
| **SCH-01** | Multimodal Search Query | - Text or transcribed voice note.<br>- No active draft/edit session open. | - Gemini extracts structured search filters.<br>- **Pass 1 (Strict):** Queries `search_text_normalized` using GIN trigrams and boundary constraints.<br>- **Pass 2 (Relaxed):** If Pass 1 returns 0, auto-widens price/area by $\pm 15\%$.<br>- Deterministic regex fallback if AI cascade fails. | Streams up to 5 matching unit cards.<br>If Pass 2: prepends note explaining boundary relaxation. If zero matches: returns helpful guidance with search widening buttons. |
| **SCH-02** | Search Pagination (`MORE_SEARCH` / `المزيد`) | - Active search state in `broker_sessions`. | - Reads stored query filters and offset.<br>- Fetches next page (`LIMIT 5 OFFSET offset`).<br>- Updates next offset in PostgreSQL. | Streams next 5 unit cards or confirms end of matching results. |
| **COL-01** | Draft vs. Search Collision | - Broker sends text/audio with search keywords while a draft is open. | - Intercepts query; detects search intent.<br>- Encodes query text into Base64.<br>- Halts automatic draft append. | "⚠️ لديك مسودة وحدة قيد الإضافة حالياً. هل تريد إلغاء المسودة وتنفيذ البحث؟"<br>Buttons: `[🔍 إلغاء والبحث]` (`cancel_and_search:<b64>`) / `[📝 إكمال المسودة]` (`draft_edit`). |

---

### 7. Deliverables & Marketing Outputs (`DEL`)

| Feature ID | Event / Trigger | Pre-Conditions & Constraints | System Execution & Safeguards | Symmetrical Response Contract |
| :--- | :--- | :--- | :--- | :--- |
| **DEL-01** | Lazy Vision Brochure Curation (`flyer:lang:theme:CODE`) | - Brochure requested for unit with `role IS NULL` images.<br>- 20s cooldown per agency + code. | - Compresses stored photos into 768px in-memory thumbnails.<br>- 1 Gemini Vision call classifies roles, selects hero facade, and enforces diversity quotas.<br>- Writes roles and `image_order` to `listing_images` and `listings.details`.<br>- Satori/Sharp generates English LTR flyer.<br>- Caches result in `flyer_cache`. | Immediate status message with dynamic median ETA, followed by flyer image delivery. |
| **DEL-02** | Client Ad Copy (`عميل <CODE>` / `client <CODE>`) | - Unit exists in `listings`. | - Arabic (`عميل`): Uses standard broker terminology, clear layout breakdown, owner equity vs. developer debt.<br>- English (`client`): Executive LTR format.<br>- Zero system metadata or technical notes. | Forwardable WhatsApp ad copy bubble with broker signature. |
| **DEL-03** | Installment Matrix Overview (`plans_view:<CODE>` / `جدول <CODE>`) | - Developer model with `payment_terms.plans`. | - Formats all approved payment plans (Down payment, years, quarterly installment, discounts).<br>- Avoids $>3$ button traps; presents Interactive List Menu with options to select specific plans (`plan_select:<CODE>:<ID>`). | Interactive List Menu presenting up to 10 payment plan options. |
| **DEL-04** | Single-Plan Client Ad Copy (`plan_select:<CODE>:<ID>`) | - Plan selected from `plans_view` list. | - Formats verified forwardable WhatsApp text via `financials.formatSinglePlanAdCopy` with net price, installment amount, and maintenance splits. | Delivers single forwardable client pitch for the selected plan. |
| **DEL-05** | Multi-Plan Excel Export (`compare_excel:<CODE>`) | - Developer model with payment plans. | - Compiles multi-tab streaming `.xlsx` workbook via `Excel.buildMultiPlanWorkbook`.<br>- Tab 1: Comparison Matrix. Tabs 2+: Chronological cash-flow schedules with maintenance balloon payments.<br>- Layout locked to English LTR; Arabic columns set to RTL reading order. | Delivers `Payment_Schedule_[CODE].xlsx` document bubble. |
| **DEL-06** | Full Agency Inventory Export (`تصدير`, `export`, `excel`) | - 60s cooldown per broker. | - Queries active listings scoped to `agency_id`.<br>- Generates executive multi-column `.xlsx` workbook via `Excel.buildAgencyInventoryWorkbook`.<br>- In-memory stream directly to WhatsApp document API. | Delivers `inventory-[DATE].xlsx` document bubble. Releases cooldown immediately on generation failure. |

---

### 8. System, Telemetry & Security Utilities (`SYS` / `SEC`)

| Feature ID | Event / Trigger | Pre-Conditions & Constraints | System Execution & Safeguards | Symmetrical Response Contract |
| :--- | :--- | :--- | :--- | :--- |
| **SYS-01** | Dynamic Help Menu (`مساعدة`, `help`) | - Any incoming text matching help regex. | - Pulls preferred language from broker record.<br>- Returns dynamically compiled command menu reflecting active syntax. | Localized help guide bubble. |
| **SYS-02** | Language Preference Toggle (`lang ar` / `lang en`) | - Broker command. | - Updates `brokers.preferred_lang` in PostgreSQL.<br>- In-memory context updated. | Localized confirmation of language switch. |
| **SYS-03** | Telemetry & Dynamic ETA | - Every completed or failed operation. | - Non-blocking insert into `operation_logs` recording latencies (`db_ms`, `gemini_ms`, `storage_upload_ms`, `total_duration_ms`), tokens, and model.<br>- Rolling percentiles (p50/p90) calculate dynamic status ETAs. | Telemetry stored safely without interrupting user transactions. |
| **SEC-01** | Webhook Cryptographic Verification | - Inbound HTTP POST to `/webhook`. | - Validates Meta's `X-Hub-Signature-256` HMAC-SHA256 signature against `WHATSAPP_APP_SECRET` using `crypto.timingSafeEqual`. | **Invalid:** HTTP 401 Unauthorized.<br>**Valid:** Proceeds to payload ingestion. |
| **SEC-02** | Row-Level Tenant Isolation | - Every SQL query across all modules. | - Enforces `WHERE agency_id = $1` on all SELECT, UPDATE, and DELETE statements.<br>- Cross-agency data access is structurally impossible. | Absolute multi-tenant segregation. |
| **SEC-03** | Startup Crash Recovery | - Server process boot (`bootRecovery()`). | - Queries `inbound_messages` for unhandled records (`status = 'new'`) from last 15 mins using `FOR UPDATE SKIP LOCKED`.<br>- Sets status to `batched` and re-dispatches messages into `executeGuardedTurn`. | Prevents message loss across Render restarts or container cycling. |
---

## 9. QA Test Verification & Traceability Baseline

When generating automated or manual test matrices, map each category to the canonical contracts below:

### A. Ingress & Media (`ING`)
* `TC-ING-01`: 1–15 photos processed into in-memory buffer; sharp resized to 1600x1600 Q82; no `/tmp` disk writes; buttons attached.
* `TC-ING-02`: Photo 16 rejected; warning dispatched; action buttons `[Save ✅]` / `[Cancel ❌]` preserved.
* `TC-ING-03`: Voice note $\le 120\text{s}$ appended to session array; voice note $> 45\text{s}$ during search rejected before AI.
* `TC-ING-04`: Draft containing only photos blocked upon finalization (`textCount === 0 && voiceCount === 0`).
* `TC-ING-05`: Unsupported media (`video`, `contacts`, `location`) returns guided response bubble (no silent drops).

### B. Bulk Ingestion (`XLS`)
* `TC-XLS-01`: Valid `.xlsx` ingested via in-memory stream buffer; atomic commit under 64-bit advisory lock.
* `TC-XLS-02`: Cells starting with dangerous characters (`=, +, -, @, \t, \r`) escaped with leading single quote (`'`).
* `TC-XLS-03`: Files $>5\text{MB}$ or missing `PK\x03\x04` magic bytes rejected with immediate explanation.
* `TC-XLS-04`: Partially rejected batches return `مرفوضات_<filename>.xlsx` with row errors detailed in Column A.

### C. Draft State Machine (`DRF`)
* `TC-DRF-01`: 15-minute sliding TTL enforced via `expires_at = NOW() + INTERVAL '15 minutes'` on `broker_sessions`.
* `TC-DRF-02`: Studios (`property_type = 'studio'`) exempt from mandatory bedroom count.
* `TC-DRF-03`: Villas/Townhouses exempt from floor level requirements; BUA and Land Area displayed.
* `TC-DRF-04`: Missing asking price, area, or compound triggers hard blocker review card.

### D. Unit Mutations & Lifecycle (`EDT`, `DEL`, `LFC`)
* `TC-EDT-01`: Direct price patch (`سعر <CODE> إلى <VAL>`) acquires 64-bit advisory lock, patches `price_value`, regenerates titles, updates GIN trigrams, and purges `flyer_cache`.
* `TC-EDT-02`: Primary developer units (`is_primary_developer = true`) block direct price mutations.
* `TC-EDT-03`: Deletion acquired under row lock (`FOR UPDATE`); confirmation button executes cascade deletion; storage purge dispatched via `setImmediate`.
* `TC-EDT-04`: Canceling deletion (`del_cancel:<CODE>`) leaves active draft sessions untouched.

### E. Search & Collisions (`SCH`, `COL`)
* `TC-SCH-01`: Pass 1 strict trigram query on `search_text_normalized`.
* `TC-SCH-02`: Pass 2 automatically widens boundary constraints by $\pm 15\%$ if Pass 1 yields 0 results.
* `TC-SCH-03`: Draft vs. Search collision (`COL-01`) intercepts search keywords while draft is active, offering `cancel_and_search` vs. `draft_edit`.
* `TC-SCH-04`: Search pagination (`MORE_SEARCH`) streams 5 units per turn and updates offset in `broker_sessions`.

### F. Deliverables & Outputs (`DEL`)
* `TC-DEL-01`: Lazy Vision executes thumbnail extraction (768px), assigns hero cover (facade/reception only), and commits roles to `listing_images`.
* `TC-DEL-02`: Satori renders 100% English LTR luxury flyers; `arabic-persian-reshaper` strictly forbidden.
* `TC-DEL-03`: Developer models format forwardable single-plan ad copy (`plan_select:<CODE>:<PLAN_ID>`) with net price and installment schedule.
* `TC-DEL-04`: Multi-plan Excel export streams multi-tab `.xlsx` with highlighted balloon payment rows.

### G. Security & Operations (`SEC`, `SYS`)
* `TC-SEC-01`: Inbound webhooks validated with timing-safe HMAC-SHA256 signature against `WHATSAPP_APP_SECRET`.
* `TC-SEC-02`: Tenant isolation enforced via strict `agency_id = $1` on all database operations.
* `TC-SEC-03`: Meta Graph API error `131047` intercepts 24-hour expiration and halts retry loops immediately.
* `TC-SEC-04`: Render `SIGTERM` initiates drain protocol (HTTP 503 response, 25s window for `inFlight` tasks).