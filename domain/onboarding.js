// domain/onboarding.js — What a new broker is shown (no I/O): the welcome card's steps, the "?" tip of each main
// screen (3-4 steps), the bot's one-time hints after the first unit, search and lead, and the day 1/3/7 nudges that
// point to the first step still missing. Arabic first; the English pages show English only.
"use strict";

const pick = (pair, lang) => pair[lang === "en" ? 1 : 0];

/** The welcome card after the first sign-in: { title, steps: [{ text, href }] } (managers also invite their team). */
function welcome({ manager = false, telegram = false } = {}, lang = "ar") {
  const steps = [
    !telegram && { text: pick(["اربط تيليجرام عشان تضيف وتدور من موبايلك وتوصلك التنبيهات.", "Link Telegram to add and search from your phone and get alerts."], lang), href: "/app/onboarding/telegram" },
    { text: pick(["ضيف أول وحدة: اكتب التفاصيل أو ابعت فويس، والصور.", "Add your first unit: type the details or send a voice note, plus photos."], lang), href: "/app/units/new" },
    { text: pick(["دوّر زي ما بتتكلم: «شقة 3 غرف في زايد تحت 5 مليون».", "Search the way you talk: \"3-bed apartment in Zayed under 5M\"."], lang), href: "/app/search" },
    { text: pick(["سجّل عميل برقمه، والبرنامج يفكرك تتابعه ويقولك لما تنزل وحدة تناسبه.", "Save a client by phone; you get follow-up reminders and units that fit them."], lang), href: "/app/leads" },
    manager && { text: pick(["ضيف فريقك من «الفريق والقواعد».", "Invite your team from \"Team and rules\"."], lang), href: "/app/team" }
  ].filter(Boolean);
  return { title: pick(["👋 أهلاً بيك في WehdatHub", "👋 Welcome to WehdatHub"], lang), steps };
}

/** The "?" tip of each main screen (by its nav key). */
const TIPS = {
  search: [
    ["اكتب طلب العميل بكلامك: النوع، المكان، الغرف، السعر.", "Type the client's request in your own words: type, place, bedrooms, price."],
    ["النتايج من وحدات وكالتك والكتالوج بس.", "Results come from your agency's units and the catalogue only."],
    ["افتح الوحدة وابعت رابطها أو صورها للعميل.", "Open a unit to send its link or photos to the client."],
    ["مفيش نتيجة؟ احفظه طلب عميل ويوصلك تنبيه لما تنزل وحدة مناسبة.", "Nothing found? Save it as a client request and get alerted when a unit fits."]
  ],
  ask: [
    ["اسأل عن مشروع أو عملائك أو وحداتك.", "Ask about a project, your clients or your units."],
    ["الإجابة من بيانات وكالتك بس، ومعاها تاريخ البيانات.", "Answers come from your agency's data only, with the data's date."],
    ["لو الإجابة مش عندنا هتقولك كده بوضوح.", "If we don't have it, it says so plainly."]
  ],
  units: [
    ["كل وحدات وكالتك المتاحة، ودوّر بالكود أو المكان.", "All your agency's available units; search by code or place."],
    ["افتح الوحدة للتعديل أو الفلاير أو إرسال الصور.", "Open a unit to edit it, make a flyer or send its photos."],
    ["اللي اتباعت أو اتأرشف بيفضل في السجل ومش بيظهر للعملاء.", "Sold or archived units stay on record and are hidden from clients."]
  ],
  add: [
    ["اكتب التفاصيل أو سجّل فويس، والبرنامج يملا الخانات.", "Type the details or record a voice note; the form fills itself."],
    ["راجع الخانات وكمّل الناقص.", "Check the fields and fill in what's missing."],
    ["ضيف الصور، وتقدر ترتبها بعدين من التعديل.", "Add photos; you can order them later when editing."],
    ["بعد الحفظ هتشوف سعر المتر مقارنة بوحدات شبهها.", "After saving you see the price per m² against similar units."]
  ],
  leads: [
    ["سجّل العميل برقمه وطلبه (نوع، مكان، ميزانية).", "Save a client with their phone and request (type, place, budget)."],
    ["كل عميل ليه مرحلة ومتابعة جاية.", "Each client has a stage and a next follow-up."],
    ["لما تنزل وحدة تناسب طلبه بيوصلك تنبيه.", "When a unit fits their request, you get an alert."],
    ["حدّث المرحلة بعد كل مكالمة أو معاينة.", "Update the stage after every call or viewing."]
  ],
  deals: [
    ["سجّل الصفقة لما العميل يوافق.", "Record a deal once the client agrees."],
    ["تابع العمولة لحد ما تتحصّل.", "Track the commission until it's collected."],
    ["المديرين بيشوفوا صفقات الفريق كله.", "Managers see the whole team's deals."]
  ],
  import: [
    ["ارفع شيت إكسيل أو شات واتساب فيه وحداتك.", "Upload an Excel sheet or a WhatsApp chat with your units."],
    ["راجع اللي اتقرا قبل الحفظ.", "Review what was read before saving."],
    ["الوحدات المكررة بتتعلّم عشان متتضافش مرتين.", "Duplicates are flagged so nothing is added twice."]
  ],
  catalogue: [
    ["مشاريع المطورين بأسعارها وأنظمة السداد.", "Developers' projects with prices and payment plans."],
    ["المديرين بيرفعوا شيت الأسعار والبروشور والصور.", "Managers upload price sheets, brochures and photos."],
    ["ابعت للعميل رابط المشروع أو الوحدة.", "Send the client the project or unit link."]
  ],
  commissions: [
    ["كل عمولة من صفقة، ومين نصيبه كام.", "Each commission comes from a deal, with everyone's share."],
    ["علّم اللي اتحصّل عشان الأرقام تبقى مظبوطة.", "Mark what's collected so the numbers stay right."],
    ["المدير يشوف الإجمالي للفريق.", "Managers see the team's total."]
  ],
  dashboard: [
    ["أرقام وكالتك: وحدات، عملاء، صفقات.", "Your agency's numbers: units, clients, deals."],
    ["مين بيرد على العملاء أسرع ومين متأخر.", "Who answers clients fastest and who is late."],
    ["اضغط على أي رقم تشوف تفاصيله.", "Tap any number for its details."]
  ]
};

/** The tip steps of a screen, or null. */
function tip(nav, lang = "ar") {
  return TIPS[nav] ? TIPS[nav].map((s) => pick(s, lang)) : null;
}

/** The bot's one-time hint after a broker's first unit, search or lead. */
const HINTS = {
  unit: [
    "💡 أول وحدة اتحفظت! جرّب: «فلاير الكود» للفلاير، «تعديل الكود» للتعديل، أو «بيع الكود» لما تتباع.",
    "💡 First unit saved! Try: \"flyer CODE\" for a flyer, \"edit CODE\" to change it, or \"sold CODE\" once it sells."
  ],
  search: [
    "💡 تقدر تدوّر بأي كلام: «فيلا في الشيخ زايد تحت 20 مليون». ولو مفيش نتيجة احفظه طلب عميل ويوصلك تنبيه.",
    "💡 Search any way you talk: \"villa in Zayed under 20M\". No result? Save it as a client request and get an alert."
  ],
  lead: [
    "💡 أول عميل اتسجل! «عملائي» تشوف كل عملائك، و«متابعات» تشوف مين محتاج مكالمة النهارده.",
    "💡 First client saved! \"leads\" lists your clients, and \"followups\" shows who needs a call today."
  ]
};
const hint = (kind, lang = "ar") => (HINTS[kind] ? pick(HINTS[kind], lang) : null);

/**
 * The day 1/3/7 nudge: the first step still missing ({ telegram, units, leads, searches } counts), or null when there
 * is nothing to nudge about. Day 7 with everything done sends one last tip.
 */
function nudge(day, progress, lang = "ar") {
  const steps = [
    !progress.telegram && {
      title: ["📲 اربط تيليجرام", "📲 Link Telegram"],
      body: ["من غير تيليجرام مش هتوصلك التنبيهات على موبايلك. افتح الإعدادات واضغط ربط تيليجرام.", "Without Telegram, alerts don't reach your phone. Open Settings and tap Link Telegram."],
      url: "/app/onboarding/telegram"
    },
    !progress.units && {
      title: ["🏠 ضيف أول وحدة", "🏠 Add your first unit"],
      body: ["ابعت تفاصيل الوحدة أو فويس للبوت، أو ضيفها من الموقع. دقيقة واحدة.", "Send the unit's details or a voice note to the bot, or add it on the website. One minute."],
      url: "/app/units/new"
    },
    !progress.leads && {
      title: ["👤 سجّل أول عميل", "👤 Save your first client"],
      body: ["اكتب «ليد» واسم العميل ورقمه، والبرنامج يفكرك بالمتابعة.", "Type \"lead\" with the client's name and phone; you get follow-up reminders."],
      url: "/app/leads"
    },
    !progress.searches && {
      title: ["🔍 جرّب البحث", "🔍 Try a search"],
      body: ["اكتب طلب عميل زي ما بتقوله، والنتايج تطلع من وحدات وكالتك.", "Type a client's request the way you'd say it; results come from your agency's units."],
      url: "/app/search"
    }
  ].filter(Boolean);
  const next = steps[0] || (day === 7 && {
    title: ["⭐ نصيحة الأسبوع", "⭐ Tip of the week"],
    body: ["اكتب «اسأل» وسؤالك عن أي مشروع أو عميل، والإجابة من بيانات وكالتك.", "Type \"ask\" and your question about any project or client; the answer comes from your agency's data."],
    url: "/app/ask"
  });
  if (!next) return null;
  return { title: pick(next.title, lang), body: pick(next.body, lang), url: next.url };
}

const NUDGE_DAYS = [1, 3, 7];

module.exports = { welcome, TIPS, tip, HINTS, hint, nudge, NUDGE_DAYS };
