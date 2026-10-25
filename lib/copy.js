// lib/copy.js — Bilingual copy for the messages Release 1 touched (one place, one wording)
"use strict";

const COPY = {
  not_found: ["🔍 الوحدة #{code} غير موجودة.", "🔍 Unit #{code} was not found."],
  not_authorized: ["⛔ ليس لديك صلاحية تعديل هذه الوحدة.", "⛔ You are not authorized to change this unit."],
  need_code: ["⚠️ اكتب كود الوحدة (مثال: «{example}»).", "⚠️ Please add the unit code (e.g. \"{example}\")."],
  status_sold: ["✅ #{code} اتسجلت *مباعة* واختفت من البحث.", "✅ #{code} is marked *sold* and hidden from search."],
  status_archived: ["📁 #{code} اتأرشفت واختفت من البحث.", "📁 #{code} is archived and hidden from search."],
  status_active: ["🟢 #{code} *متاحة* — تم تأكيد التوفر اليوم.", "🟢 #{code} is *available* — availability confirmed today."],
  price_updated: ["✅ سعر #{code} بقى *{price}*.", "✅ #{code} price is now *{price}*."],
  price_invalid: ["⚠️ صيغة السعر غير صحيحة. مثال: «سعر {code} 8.5 مليون».", "⚠️ Invalid price. Example: \"price {code} 8.5M\"."],
  price_developer: [
    "⚠️ لا يمكن تعديل أسعار وحدات المطورين مباشرة لارتباطها بجدول أقساط معتمد. ارفع شيت الأسعار المحدث.",
    "⚠️ Developer unit prices are tied to a payment matrix and cannot be edited directly. Upload the updated price sheet."
  ],
  edit_open: [
    "✏️ تعديل #{code}: ابعت التعديلات (كتابة أو فويس)، وبعدين اكتب «تم» للمراجعة.",
    "✏️ Editing #{code}: send the changes (text or voice), then type *done* to review."
  ],
  edit_added: ["📝 اتضاف للتعديل. ابعت المزيد أو اضغط مراجعة.", "📝 Added to the edit. Send more or tap Review."],
  edit_nothing: ["⚠️ مفيش تعديلات لسه. ابعت التعديل (مثال: «السعر 9 مليون»).", "⚠️ No changes yet. Send a change (e.g. \"price 9M\")."],
  edit_saved: ["✅ *تم حفظ التعديل*", "✅ *Changes saved*"],
  edit_conflict: [
    "⚠️ الوحدة #{code} اتعدلت من شخص تاني أثناء المراجعة. راجع التعديل تاني.",
    "⚠️ #{code} was changed by someone else during your review. Please review again."
  ],
  edit_expired: ["⏳ جلسة التعديل انتهت. اكتب «تعديل» وكود الوحدة للبدء من جديد.", "⏳ The edit session expired. Type \"edit\" and the unit code to start again."],
  edit_cancelled: ["🗑️ تم إلغاء التعديل. الوحدة زي ما هي.", "🗑️ Edit cancelled. The unit is unchanged."],
  quick_menu: ["⚙️ تحديث سريع للوحدة #{code}:", "⚙️ Quick update for #{code}:"],
  web_login_link: [
    "🌐 رابط الدخول لموقع AqarChat (صالح {minutes} دقيقة ولمرة واحدة):\n{url}\n\n🔒 متبعتوش لحد.",
    "🌐 Your AqarChat sign-in link (valid {minutes} minutes, one use):\n{url}\n\n🔒 Do not forward it."
  ],
  web_login_limited: ["⏳ طلبت روابط دخول كتير. حاول تاني بعد شوية.", "⏳ Too many sign-in links requested. Try again later."],
  web_login_ceiling: [
    "⏳ روابط الدخول الشهرية للوكالة خلصت. لو مسجل دخول على الموقع قبل كده كمّل منه، أو كلم مدير الوكالة.",
    "⏳ Your agency's sign-in links for this month are used up. If you're already signed in on the website, carry on there, or ask your agency manager."
  ],
  // Message credits (lib/credits.js): hints ride on a reply already being sent; the ceiling notice is once a day.
  credits_hint_50: [
    "ℹ️ الوكالة استخدمت نص رصيد رسايل واتساب الشهر ده. البحث الطويل والإضافة والاستيراد ببلاش على الموقع: {url}",
    "ℹ️ Your agency has used half of this month's WhatsApp credits. Long searches, adding units and imports are free on the website: {url}"
  ],
  credits_hint_80: [
    "⚠️ الوكالة استخدمت 80% من رصيد واتساب الشهر ده. اعمل المهام الكبيرة على الموقع (ببلاش): {url}",
    "⚠️ Your agency has used 80% of this month's WhatsApp credits. Do the big tasks on the website (free): {url}"
  ],
  credits_hint_100: [
    "📵 رصيد واتساب الشهري للوكالة خلص. التنبيهات هتوصلك على الموقع من دلوقتي: فعّل الإشعارات وضيف الموقع للشاشة الرئيسية: {url}",
    "📵 Your agency's monthly WhatsApp credits are used up. Alerts now come on the website: turn on notifications and add it to your home screen: {url}"
  ],
  credits_ceiling: [
    "⛔ وصلنا للحد الشهري لرسايل واتساب. كمّل على الموقع: {url}\nالبوت هيعلّم رسايلك مقروءة ومش هيرد لحد الشهر الجاي.",
    "⛔ The monthly WhatsApp limit is reached. Carry on on the website: {url}\nThe bot will mark your messages as read but won't reply until next month."
  ],
  photos_received: ["📸 وصلت {n} صور.", "📸 {n} photos received."],
  photo_received: ["📸 وصلت صورة.", "📸 1 photo received."],
  // CRM leads (Release 3 step 4): WhatsApp intake, the card, "who is calling?"
  lead_draft_open: [
    "👤 عميل جديد: ابعت رسالة العميل (فوروارد)، أو رقمه، أو فويس نوت بالتفاصيل. (30 دقيقة)",
    "👤 New lead: forward the client's message, or send their number or a voice note. (30 minutes)"
  ],
  draft_duplicate: ["⚠️ شكلها نفس الوحدة {code} اللي عندك: {url}\nلو دي وحدة تانية، احفظ برضه.", "⚠️ This looks like {code}, already listed: {url}\nIf it is another unit, save anyway."],
  lead_offer_new: ["👤 {who} مش متسجل عندك. تحفظه كعميل؟", "👤 {who} isn't saved yet. Save as a client?"],
  lead_offer_forward: ["👤 ده عميل؟ لقيت فيه رقم {phone}.", "👤 Is this a client? I found the number {phone}."],
  lead_understood: ["🤖 فهمت كده:\n{lines}\n\nأحفظه؟", "🤖 I understood:\n{lines}\n\nSave it?"],
  lead_need_phone: [
    "📱 ابعت رقم العميل وأنا أكمّل ({name}). الطلب محفوظ 30 دقيقة.",
    "📱 Send the client's number and I'll finish ({name}). Kept for 30 minutes."
  ],
  lead_bad_phone: ["⚠️ الرقم «{phone}» مش مظبوط. ابعته تاني (مثال: 01012345678).", "⚠️ The number \"{phone}\" doesn't look right. Send it again (e.g. 01012345678)."],
  lead_pick_phone: ["📱 لقيت {n} أرقام. أنهي رقم العميل؟", "📱 I found {n} numbers. Which one is the client's?"],
  lead_ai_down: [
    "⚠️ مش قادر أقرا التفاصيل دلوقتي. أحفظ الرقم {phone} لوحده وتكمّل بعدين؟",
    "⚠️ I can't read the details right now. Save the number {phone} alone and add the rest later?"
  ],
  lead_ai_down_no_phone: ["⚠️ مش قادر أقرا التفاصيل دلوقتي. ابعت رقم العميل وأنا أحفظه.", "⚠️ I can't read the details right now. Send the client's number and I'll save it."],
  lead_ai_quota: ["⛔ حد الذكاء الاصطناعي اليومي خلص. ابعت رقم العميل لوحده وأنا أحفظه.", "⛔ The daily AI limit is reached. Send the client's number alone and I'll save it."],
  request_no_lead: ["🔎 لمين الطلب ده؟ افتح العميل الأول (ابعت L-0042) وبعدين «طلب …»، أو اكتب «طلب L-0042 …».", "🔎 Which client is this for? Open the client first (send L-0042), then «request …», or write «request L-0042 …»."],
  request_need_text: ["🔎 اكتب الطلب بعد «طلب»، مثال: طلب شقة 3 غرف في التجمع تحت 8 مليون.", "🔎 Write the request after «request», e.g. request 3-bedroom apartment in New Cairo under 8M."],
  request_unclear: ["🤔 مفهمتش الطلب. اكتب النوع والمكان والميزانية، مثال: طلب شقة 3 غرف في زايد تحت 6 مليون.", "🤔 I didn't get the request. Write the type, place and budget, e.g. request 3-bedroom apartment in Zayed under 6M."],
  request_too_many: ["⚠️ العميل {ref} عنده 3 طلبات (الحد الأقصى). امسح واحد من صفحة العميل: {url}", "⚠️ {ref} already has 3 requests (the most). Remove one on the lead's page: {url}"],
  request_saved: ["🔎 طلب {ref} اتحفظ: {summary}\nهبلغك أول ما تنزل وحدة تناسبه.", "🔎 Request saved for {ref}: {summary}\nI'll tell you when a unit that fits comes in."],
  request_matches: ["🏠 {n} وحدة مناسبة دلوقتي:", "🏠 {n} units fit now:"],
  request_none: ["🏠 مفيش وحدات مناسبة دلوقتي.", "🏠 No unit fits right now."],
  request_all: ["🌐 كل الوحدات المناسبة: {url}", "🌐 All units that fit: {url}"],
  unit_wanted: ["🔥 {n} عملاء عايزين الوحدة دي", "🔥 {n} clients want this unit"],
  unit_wanted_list: ["🔥 {n} عملاء طلباتهم تناسب {code}. اختار عميل تبعتله الوحدة:", "🔥 {n} clients' requests fit {code}. Pick a client to send it to:"],
  unit_wanted_others: ["👥 و{n} مع زملائك.", "👥 And {n} with your colleagues."],
  unit_wanted_none: ["🔍 مفيش عملاء ليك طلباتهم تناسب {code} دلوقتي.", "🔍 None of your clients' requests fit {code} right now."],
  send_to_client: ["💬 ابعت {code} لـ {who}: اضغط الرابط، واتساب هيفتح والرسالة جاهزة.\n{url}", "💬 Send {code} to {who}: tap the link, WhatsApp opens with the message ready.\n{url}"],
  send_unit_gone: ["⚠️ الوحدة {code} مش متاحة دلوقتي.", "⚠️ {code} isn't available now."],
  request_need_phone: ["🔔 ابعت رقم العميل (أو حوّل رسالته) وهحفظ الطلب ده ليه، وهبلغك أول ما تنزل وحدة تناسبه.", "🔔 Send the client's number (or forward their message) and I'll save this request for them and tell you when a unit fits."],
  lead_saved: ["✅ اتسجل {ref}", "✅ Saved {ref}"],
  lead_known: ["📇 العميل ده متسجل عندك بالفعل ({ref}).", "📇 This client is already yours ({ref})."],
  lead_claimed: ["✅ العميل كان من غير وسيط، واتسجل باسمك ({ref}).", "✅ The client had no broker; now assigned to you ({ref})."],
  lead_colleague: [
    "👥 العميل ده متسجل مع زميل. مديرك اتبلّغ وهو هيقرر.",
    "👥 This client is already registered with a colleague. Your manager has been told and will decide."
  ],
  lead_colleague_lookup: ["👥 الرقم ده عميل متسجل مع زميل. لو محتاج تشتغل عليه كلم مديرك.", "👥 This number is a colleague's client. Ask your manager if you need to work with them."],
  lead_erased: [
    "🔒 العميل ده طلب قبل كده إن بياناته تتمسح. احفظه بس لو هو اللي كلمك تاني.",
    "🔒 This client asked earlier for their data to be deleted. Save them only if they contacted you again."
  ],
  lead_invalid: ["⚠️ مش قادر أحفظ العميل: {why}.", "⚠️ Can't save the client: {why}."],
  lead_cancelled: ["🗑️ اتلغى. محدش اتحفظ.", "🗑️ Cancelled. Nothing was saved."],
  lead_expired: ["⏳ الطلب ده انتهى. ابعت العميل تاني.", "⏳ This has expired. Send the client again."],
  lead_edit_prompt: [
    "✏️ ابعت التصحيح (مثال: «الاسم أحمد»، «مستأجر»، «الميزانية 9 مليون») وأنا أقرا تاني.",
    "✏️ Send the correction (e.g. \"name Ahmed\", \"tenant\", \"budget 9M\") and I'll read it again."
  ],
  lead_gone: ["⚠️ العميل {ref} مبقاش معاك (اتحول لزميل) أو مش موجود.", "⚠️ Lead {ref} is no longer yours (reassigned) or doesn't exist."],
  lead_contacted: ["📞 {ref}: اتسجل إنك كلمته.", "📞 {ref}: marked as contacted."],
  lead_contacted_suggest: ["📞 {ref}: اتسجل إنك كلمته. مفيش متابعة جاية؛ أحطلك واحدة بعد يومين؟", "📞 {ref}: marked as contacted. No next step yet; set a follow-up in 2 days?"],
  lead_follow_up_set: ["⏰ {ref}: متابعة {when}.", "⏰ {ref}: follow-up {when}."],
  lead_follow_up_done: ["✅ {ref}: المتابعة خلصت. أحطلك المتابعة الجاية بعد يومين؟", "✅ {ref}: follow-up done. Set the next one in 2 days?"],
  lead_no_follow_up: ["{ref}: مفيش متابعة مفتوحة دلوقتي.", "{ref}: no open follow-up now."],
  lead_follow_up_menu: ["📅 متابعة {ref} إمتى؟ (الساعة 10 الصبح)", "📅 Follow up {ref} when? (10:00)"],
  lead_stage_menu: ["🔄 مرحلة {ref} دلوقتي: {stage}. اختار الجديدة:", "🔄 {ref} is at {stage}. Choose the new stage:"],
  lead_lost_menu: ["❌ ليه {ref} ضاع؟", "❌ Why was {ref} lost?"],
  lead_stage_set: ["➡️ {ref}: {stage}.", "➡️ {ref}: {stage}."],
  lead_unchanged: ["ℹ️ {ref} أصلاً كده.", "ℹ️ {ref} is already like that."],
  lead_conflict: ["⚠️ {ref} اتعدل من شخص تاني. افتح الكارت تاني: {ref}", "⚠️ {ref} was changed by someone else. Open the card again: {ref}"],
  lead_undone: ["↩️ اتلغى ورجع زي ما كان ({ref}).", "↩️ Undone ({ref})."],
  lead_undo_expired: ["⏳ التراجع متاح 10 دقايق بس.", "⏳ Undo is only available for 10 minutes."],
  lead_undo_blocked: ["⚠️ مش ممكن التراجع: العميل اتعدل بعدها.", "⚠️ Can't undo: the lead changed since."],
  lead_unit_draft: [
    "📝 مسودة وحدة جديدة لـ {name}: اسم المالك ورقمه متسجلين (داخلي، مش بيظهروا للعملاء). ابعت الصور والتفاصيل، واكتب «تم» للمراجعة.",
    "📝 New unit draft for {name}: the owner's name and phone are filled in (internal, never shown to clients). Send photos and details, then type *done* to review."
  ],
  lead_my_empty: [
    "👤 مفيش عملاء لسه. ابعت رسالة عميل (فوروارد) أو اكتب «ليد».",
    "👤 No leads yet. Forward a client's message or type *lead*."
  ],
  lead_my_list: ["👤 عملائك ({n}):\n{lines}{more}\n\n🌐 كلهم على الموقع: {url}", "👤 Your leads ({n}):\n{lines}{more}\n\n🌐 All of them on the website: {url}"],
  lead_follow_ups_empty: ["⏰ مفيش متابعات مفتوحة. 🌐 {url}", "⏰ No open follow-ups. 🌐 {url}"],
  lead_follow_ups_list: ["⏰ متابعاتك ({n}):\n{lines}{more}\n\n🌐 {url}", "⏰ Your follow-ups ({n}):\n{lines}{more}\n\n🌐 {url}"],
  lead_more: ["\n… و{n} كمان", "\n… and {n} more"],
  lead_managers_only: ["⛔ التحويل للمديرين بس.", "⛔ Only managers can assign leads."],
  lead_no_broker: ["⚠️ مفيش وسيط اسمه «{name}». اكتب جزء من الاسم.", "⚠️ No broker named \"{name}\". Type part of the name."],
  lead_pick_broker: ["👥 أكتر من وسيط بالاسم ده. اختار:", "👥 More than one broker matches. Choose:"],
  lead_assigned: ["✅ {ref} اتحول لـ {name}.", "✅ {ref} assigned to {name}."]
};

/** Message text for a key, with {placeholders} filled in. */
function t(key, lang = "ar", vars = {}) {
  const pair = COPY[key];
  if (!pair) throw new Error(`Unknown copy key: ${key}`);
  return (lang === "en" ? pair[1] : pair[0]).replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? `{${k}}`));
}

module.exports = { COPY, t };
