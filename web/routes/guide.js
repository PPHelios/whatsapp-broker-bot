// web/routes/guide.js — The quick guide and FAQ (phase 2 step 1): /app/guide, open to everyone (signed in or not, in the
// website and the Telegram Mini App), Arabic or English with the usual ?lang= switch. The bot's help reply links here
// (Links.guideUrl). Content only: no data is read.
"use strict";

const { html } = require("../html");
const Words = require("../../domain/commandWords");

const T = (lang, pair) => pair[lang === "en" ? 1 : 0];

const SECTIONS = [
  {
    id: "start",
    title: ["🚀 البداية", "🚀 Getting started"],
    items: [
      ["مديرك يضيفك من «فريقي» ويبعتلك لينك تيليجرام. دوس عليه مرة واحدة وحسابك يتربط بالبوت @Wehdat_Hub_bot.", "Your manager adds you from \"My team\" and sends you a Telegram link. Tap it once and your account is linked to the @Wehdat_Hub_bot bot."],
      ["زرار القائمة في البوت بيفتح الموقع جوه تيليجرام وإنت داخل على طول.", "The menu button in the bot opens the website inside Telegram, already signed in."],
      ["على الكمبيوتر: ابعت «دخول» أو /login للبوت وهيوصلك لينك دخول للموقع.", "On a computer: send \"login\" or /login to the bot and you get a sign-in link for the website."],
      ["ابعت «مساعدة» أو /help في أي وقت عشان تشوف كل الأوامر.", "Send \"help\" or /help any time to see every command."]
    ]
  },
  {
    id: "limits",
    title: ["🚦 الحدود والرصيد", "🚦 Limits and credits"],
    items: [
      ["باقتك ليها رصيد شهري من رسايل الذكاء الاصطناعي (نص) والفويس، وعدد وحدات متاحة، وعدد مستخدمين. الوحدات المباعة والمؤرشفة مش بتتحسب.", "Your plan has a monthly allowance of AI messages (text) and voice notes, a number of available units and a number of users. Sold and archived units don't count."],
      ["قراية قوايم الأسعار (PDF وصور) بالذكاء الاصطناعي ليها حد صفحات شهري ومقفولة لحد ما صاحب التطبيق يفتحها. الصفحة اللي اتقرت قبل كده ببلاش، وشيت الإكسيل بيتقرا ببلاش.", "AI reading of price lists (PDF and photos) has a monthly page limit and is off until the app owner switches it on. A page read before is free, and an Excel sheet is read free."],
      ["ردود المساعد من الإنترنت اختيارية، ليها حد شهري، ومكتوب عليها غير مؤكد. الرد من بيانات وكالتك مش بيتحسب منها.", "Assistant web answers are optional, have a monthly limit and are labelled unverified. Answers from your agency's data don't use it."],
      ["ترتيب الصور بإيدك (سحب وإفلات) بيوفر رصيد الذكاء الاصطناعي. المدير يقفل ترتيب الصور بالذكاء الاصطناعي لكل الوكالة من صفحة استخدامي.", "Ordering photos by hand (drag and drop) saves AI credits. A manager can switch AI photo ordering off for the whole agency on My usage."],
      ["المدير يشوف كل الحدود وكام استهلكت من لوحة الوكالة، وصفحة الباقة فيها الأسعار والترقية. لو الحد خلص، كل حاجة بتفضل شغالة بإيدك وبياناتك مش بتتمسح.", "Managers see every limit and how much is used on the agency dashboard; the Plan page has prices and upgrades. When a limit is reached everything keeps working by hand and your data is never deleted."]
    ]
  },
  {
    id: "units",
    title: ["🏠 الوحدات", "🏠 Units"],
    items: [
      ["ابعت «إضافة»، بعدين الصور، بعدين فويس أو رسالة بالتفاصيل (الكمبوند، المساحة، السعر، الغرف)، واكتب «تم». البوت يوريك فهم إيه وتأكد.", "Send \"add\", then the photos, then a voice note or a message with the details (compound, area, price, bedrooms), and send \"done\". The bot shows what it understood for you to confirm."],
      ["كل وحدة بتاخد كود قصير زي NH-V12 (حروف الوكالة + نوع الوحدة + رقم). ابعت الكود في أي وقت يطلعلك الكارت.", "Every unit gets a short code like NH-V12 (agency letters + unit type + number). Send the code any time to get its card."],
      ["من الكارت: تعديل، تم البيع، أرشفة، لينك للعميل، بروشور.", "From the card: edit, mark sold, archive, a client link, a flyer."],
      ["لو وحدة متعدلتش ٢١ يوم، البوت يسألك «لسه متاحة؟». لو محدش رد لحد ٣٠ يوم بتتخفى من البحث (مش بتتمسح).", "If a unit hasn't changed for 21 days the bot asks \"still available?\". With no answer by day 30 it is hidden from search (never deleted)."],
      ["من الموقع تقدر تستورد شيت إكسيل أو شات واتساب متصدّر.", "On the website you can import an Excel sheet or an exported WhatsApp chat."]
    ]
  },
  {
    id: "search",
    title: ["🔍 البحث", "🔍 Search"],
    items: [
      ["اكتب أو سجّل اللي العميل عايزه بكلامك: «شقة في التجمع ٣ غرف تحت ١٠ مليون».", "Type or say what the client wants in your own words: \"apartment in New Cairo, 3 beds, under 10M\"."],
      ["النتايج بتيجي بصورة لكل وحدة؛ دوس على وحدة تشوف صورها وتفاصيلها.", "Results come with a photo per unit; tap one to see its photos and details."],
      ["«شوف الكل» بيفتح نفس البحث على الموقع عشان تفلتر أكتر.", "\"See all\" opens the same search on the website to filter further."]
    ]
  },
  {
    id: "clients",
    title: ["👤 العملاء", "👤 Clients"],
    items: [
      ["ابعت «ليد» ومعاه رسالة العميل أو فويس، أو حوّل رسالته، أو ابعت رقمه. البوت يعمل كارت العميل بعد ما تأكد.", "Send \"lead\" with the client's message or a voice note, forward their message, or send their number. The bot makes the client's card once you confirm."],
      ["عملاء إعلانات فيسبوك: المدير يرفع ملف CSV من Meta Leads Center في «العملاء ← استيراد».", "Facebook ad leads: a manager uploads the Meta Leads Center CSV under \"Leads → Import\"."],
      ["أزرار الكارت: 📞 كلمته، 📅 متابعة، 🔄 المرحلة. كل مرحلة بتتسجل في التقارير.", "Card buttons: 📞 Called, 📅 Follow-up, 🔄 Stage. Every stage counts in the reports."],
      ["احفظ طلب العميل («طلب» + اللي عايزه) وأول ما تنزل وحدة تناسبه أو سعرها ينزل هتتبلغ.", "Save the client's request (\"request\" + what they want) and you hear as soon as a unit fits or drops its price."],
      ["«عملائي» و«متابعات» بيجيبولك قوايمك في أي وقت.", "\"leads\" and \"followups\" bring up your lists any time."]
    ]
  },
  {
    id: "daily",
    title: ["⏰ رسايل اليوم", "⏰ Daily messages"],
    items: [
      ["الصبح (٩–١٢): ملخص متابعاتك وعملائك الجداد.", "Morning (9–12): your follow-ups and new clients."],
      ["المسا (٧–١٠) للمديرين: ملخص يوم الوكالة.", "Evening (7–10), managers: the agency's day."],
      ["من «الإعدادات» تختار القناة لكل نوع تنبيه وساعات الهدوء؛ التنبيهات اللي بتيجي وقت الهدوء بتتجمع في رسالة واحدة بعده.", "In Settings you pick the channel for each alert and your quiet hours; alerts during quiet hours arrive together in one message afterwards."]
    ]
  },
  {
    id: "managers",
    title: ["👥 للمديرين", "👥 For managers"],
    items: [
      ["«فريقي»: ضيف وسيط، اعمله لينك تيليجرام، أو أوقفه (عملاؤه بيرجعوا للمديرين).", "\"My team\": add a broker, make their Telegram link, or deactivate them (their clients come back to the managers)."],
      ["«لوحة الوكالة»: العملاء والصفقات والعمولة وترتيب البروكرز لآخر ٧ أو ٣٠ أو ٩٠ يوم.", "\"Agency dashboard\": leads, deals, commission and the broker leaderboard for the last 7, 30 or 90 days."],
      ["حوّل عميل لبروكر: «حول L-0042 لـ سارة».", "Hand a client to a broker: \"assign L-0042 to Sara\"."]
    ]
  }
];

const FAQ = [
  [["هل بياناتي بيشوفها حد من وكالة تانية؟", "Can another agency see my data?"], ["لأ. كل وكالة شايفة وحداتها وعملاءها بس.", "No. Every agency sees only its own units and clients."]],
  [["العميل بيشوف إيه لما أبعتله لينك وحدة؟", "What does a client see when I send a unit link?"], ["صفحة فيها الصور والتفاصيل ورقم تواصل الوكالة، من غير أي بيانات داخلية. لو الوحدة اتباعت اللينك بيقول إنها مبقتش متاحة.", "A page with the photos, the details and the agency's contact number, with no internal data. If the unit is sold the link says it's no longer available."]],
  [["العميل طلب يمسح بياناته؛ أعمل إيه؟", "A client asked us to delete their data. What do I do?"], ["المدير يفتح العميل على الموقع ويختار «مسح نهائي» ويكتب آخر ٤ أرقام من رقمه. وتقدر تصدّر بياناته الأول لو طلبها.", "A manager opens the client on the website, chooses \"Erase for good\" and types the last 4 digits of their number. You can export their data first if they ask for it."]],
  [["البوت فهم غلط؛ أصلّحه إزاي؟", "The bot got something wrong. How do I fix it?"], ["قبل الحفظ دوس «✏️ تعديل». بعد الحفظ: «تعديل الكود السعر ٩٫٥ مليون» أو من الموقع.", "Before saving tap \"✏️ Edit\". After saving: \"edit CODE price 9.5M\" or use the website."]],
  [["في حاجة مش شغالة.", "Something isn't working."], ["ابعت «عطل» واللي حصل للبوت، أو «🐞 بلّغ عن مشكلة» تحت أي صفحة. هيوصلك رقم البلاغ.", "Send \"bug\" and what happened to the bot, or use \"🐞 Report a problem\" at the bottom of any page. You get a report number."]],
  [["ليه تيليجرام مش واتساب؟", "Why Telegram and not WhatsApp?"], ["تيليجرام مجاني للرسايل والصور والأزرار، فالتنبيهات مش بتتكلف. واتساب بيفضل للتواصل مع العملاء.", "Telegram is free for messages, photos and buttons, so alerts cost nothing. WhatsApp stays for talking to clients."]],
  [["الموقع بطيء أول ما بفتحه.", "The website is slow the first time I open it."], ["في فترة التجربة السيرفر بينام لما محدش بيستخدمه، وأول فتحة ممكن تاخد دقيقة.", "During the trial the server sleeps when nobody uses it, so the first load can take up to a minute."]]
];

/** A command's words as <code> chips (the example when it has no word). The English page shows the English words only. */
function commandWords(c, lang) {
  const arg = (en) => (en ? c.argEn || c.arg : c.arg);
  const chip = (w, en) => html`<code dir="${en ? "ltr" : "rtl"}">${w}${arg(en) ? ` ${arg(en)}` : ""}</code>`;
  const words = lang === "en" ? (c.en.length ? c.en : [c.enHint].filter(Boolean)).map((w) => chip(w, true)) : [...c.ar.map((w) => chip(w, false)), ...c.en.map((w) => chip(w, true))];
  const example = lang === "en" ? c.exampleEn || c.example : c.example;
  return words.length ? html`${words.map((x, i) => html`${i ? " / " : ""}${x}`)}` : html`<code dir="auto">${example}</code>`;
}

function guidePage(lang) {
  return html`<h1>📘 ${T(lang, ["دليل سريع", "Quick guide"])}</h1>
<nav class="card row" aria-label="${T(lang, ["المحتوى", "Contents"])}"><a href="#commands">📖 ${T(lang, ["الأوامر", "Commands"])}</a>${SECTIONS.map((s) => html`<a href="#${s.id}">${T(lang, s.title)}</a>`)}<a href="#faq">❓ ${T(lang, ["أسئلة شائعة", "FAQ"])}</a></nav>
<section class="card" id="commands">
  <h2>📖 ${T(lang, ["أوامر البوت", "Bot commands"])}</h2>
  <p class="muted">${T(lang, ["العربي بأي طريقة كتابة (أ/ا، ة/ه، ى/ي زي بعض) والإنجليزي كابيتال أو سمول.", "English words work in any case. Arabic words work in any spelling (switch the guide to Arabic to see them)."])}</p>
  ${Words.grouped().map((g) => html`<h3>${T(lang, g.title)}</h3><div class="scroll"><table data-commands="${g.id}"><tbody>${g.commands.map((c) => html`<tr><td>${commandWords(c, lang)}</td><td>${T(lang, c.help)}${c.manager ? T(lang, [" (للمديرين)", " (managers)"]) : ""}</td></tr>`)}</tbody></table></div>`)}
</section>
${SECTIONS.map(
  (s) => html`<section class="card" id="${s.id}">
  <h2>${T(lang, s.title)}</h2>
  <ul>${s.items.map((i) => html`<li>${T(lang, i)}</li>`)}</ul>
</section>`
)}
<section class="card" id="faq">
  <h2>❓ ${T(lang, ["أسئلة شائعة", "FAQ"])}</h2>
  ${FAQ.map(([q, a]) => html`<details><summary>${T(lang, q)}</summary><p>${T(lang, a)}</p></details>`)}
</section>`;
}

function register(web, { page }) {
  web.get("/guide", (req, res) => page(req, res, { title: T(req.lang, ["دليل سريع", "Quick guide"]), langSwitch: true, body: guidePage(req.lang) }));
}

module.exports = { register, SECTIONS, FAQ };
