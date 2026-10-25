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
  photo_received: ["📸 وصلت صورة.", "📸 1 photo received."]
};

/** Message text for a key, with {placeholders} filled in. */
function t(key, lang = "ar", vars = {}) {
  const pair = COPY[key];
  if (!pair) throw new Error(`Unknown copy key: ${key}`);
  return (lang === "en" ? pair[1] : pair[0]).replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? `{${k}}`));
}

module.exports = { COPY, t };
