// domain/describe.js — The one description template for every surface (pure)
// Every captured detail appears; unknown fields are left out silently; nothing is invented.
// Field warnings exist only in reviewCard (add/edit); no other surface can show them.
"use strict";

const Features = require("./features");
const Delivery = require("./delivery");
const Rules = require("./fieldRules");

const TYPE_LABELS = {
  apartment: ["شقة", "Apartment"],
  duplex: ["دوبلكس", "Duplex"],
  penthouse: ["بنتهاوس", "Penthouse"],
  chalet: ["شاليه", "Chalet"],
  studio: ["استوديو", "Studio"],
  villa: ["فيلا", "Villa"],
  townhouse: ["تاون هاوس", "Townhouse"],
  twinhouse: ["توين هاوس", "Twin house"],
  office: ["مكتب", "Office"],
  shop: ["محل", "Shop"],
  clinic: ["عيادة", "Clinic"],
  commercial: ["وحدة تجارية", "Commercial unit"],
  land: ["أرض", "Land"]
};

const FINISHING_LABELS = {
  core_and_shell: ["بدون تشطيب", "Core & shell"],
  semi_finished: ["نصف تشطيب", "Semi-finished"],
  fully_finished: ["تشطيب كامل", "Fully finished"],
  super_lux: ["سوبر لوكس", "Super lux"],
  ultra_super_lux: ["الترا سوبر لوكس", "Ultra super lux"]
};

const FURNISHING_LABELS = {
  furnished: ["مفروشة", "Furnished"],
  semi_furnished: ["نصف فرش", "Semi-furnished"],
  unfurnished: ["بدون فرش", "Unfurnished"]
};

const FREQUENCY_LABELS = {
  monthly: ["شهري", "monthly"],
  quarterly: ["ربع سنوي", "quarterly"],
  semi_annual: ["نصف سنوي", "semi-annual"],
  annual: ["سنوي", "annual"]
};

const pick = (pair, lang) => (pair ? (lang === "en" ? pair[1] : pair[0]) : null);
const known = (v) => v !== null && v !== undefined && v !== "";
const num = (v) => (known(v) && Number.isFinite(Number(v)) ? Number(v) : null);

/** Short money: "8.5 مليون" / "8.5M"; EGP is implied, other currencies are named. */
function money(value, lang = "ar", currency = "EGP") {
  const n = num(value);
  if (n === null || n <= 0) return null;
  const cur = currency && currency !== "EGP" ? ` ${lang === "en" ? currency : currency === "USD" ? "دولار" : "يورو"}` : "";
  const round = (x, d) => parseFloat(x.toFixed(d));
  if (lang === "en") {
    if (n >= 1e6) return `${round(n / 1e6, 2)}M${cur || " EGP"}`;
    if (n >= 1e3) return `${round(n / 1e3, 1)}K${cur || " EGP"}`;
    return `${n.toLocaleString("en-US")}${cur || " EGP"}`;
  }
  if (n >= 1e6) return `${round(n / 1e6, 2)} مليون${cur || " ج.م"}`;
  if (n >= 1e3) return `${round(n / 1e3, 1)} ألف${cur || " ج.م"}`;
  return `${n.toLocaleString("en-US")}${cur || " ج.م"}`;
}

const currencyOf = (l) => l.details?.currency || l.currency || "EGP";
const typeLabel = (l, lang) => pick(TYPE_LABELS[String(l.property_type || "").toLowerCase()], lang) || (lang === "en" ? "Unit" : "وحدة");
const isRent = (l) => l.listing_type === "rent";
const kindOf = (l) => Rules.unitKind(l.property_type);

/** Price text; rent always reads per month (or per year when stated) exactly once. */
function priceLabel(l, lang = "ar") {
  const m = money(l.price_value, lang, currencyOf(l));
  if (!m) return null;
  if (!isRent(l)) return m;
  const yearly = l.details?.rent_period === "yearly";
  return `${m} ${lang === "en" ? (yearly ? "/ year" : "/ month") : yearly ? "سنوياً" : "شهرياً"}`;
}

function areaLabel(l, lang = "ar") {
  const a = num(l.area_value);
  if (!a) return null;
  const unit = lang === "en" ? "m²" : "م";
  return kindOf(l) === "villa" ? `${a}${unit} ${lang === "en" ? "BUA" : "مباني"}` : `${a}${unit}`;
}

/** "3 غرف" / "غرفة واحدة" / null for studios and commercial units (the type already says it). */
function bedsLabel(l, lang = "ar") {
  const k = kindOf(l);
  if (k === "studio" || k === "commercial" || k === "land") return null;
  const b = num(l.bedrooms);
  if (b === null || b < 1) return null;
  if (lang === "en") return `${b} bed${b === 1 ? "" : "s"}`;
  return b === 1 ? "غرفة واحدة" : b === 2 ? "غرفتين" : `${b} غرف`;
}

function bathsLabel(l, lang = "ar") {
  const b = num(l.bathrooms ?? l.details?.bathrooms);
  if (b === null || b < 1) return null;
  if (lang === "en") return `${b} bath${b === 1 ? "" : "s"}`;
  return b === 1 ? "حمام واحد" : b === 2 ? "حمامين" : `${b} حمامات`;
}

function floorLabel(l, lang = "ar") {
  if (kindOf(l) === "villa") return null;
  const d = l.details || {};
  if (lang === "en" && d.floor_en) return `${d.floor_en}`;
  if (lang !== "en" && d.floor) return `الدور ${String(d.floor).replace(/^الدور\s*/, "")}`;
  const f = num(l.floor_level);
  if (f === null) return null;
  if (f === 0) return lang === "en" ? "Ground floor" : "الدور الأرضي";
  if (f < 0) return lang === "en" ? "Basement" : "البدروم";
  return lang === "en" ? `Floor ${f}` : `الدور ${f}`;
}

function finishingLabel(l, lang = "ar") {
  const label = pick(FINISHING_LABELS[l.finishing], lang);
  if (label) return label;
  // Rows saved before Release 1 keep finishing as free text in details.
  const d = l.details || {};
  return lang === "en" ? latinOnly(d.finishing_en) || latinOnly(d.finishing) : d.finishing || null;
}

function furnishingLabel(l, lang = "ar") {
  return pick(FURNISHING_LABELS[l.furnishing], lang);
}

function frequencyLabel(freq, lang = "ar") {
  return pick(FREQUENCY_LABELS[freq], lang);
}

/** Years left on a resale schedule, computed when shown (never stored). */
function yearsLeft(l, now = new Date()) {
  if (!l.installments_end) return num(l.installment_years);
  const end = new Date(l.installments_end);
  if (Number.isNaN(end.getTime())) return null;
  const months = (end.getUTCFullYear() - now.getUTCFullYear()) * 12 + (end.getUTCMonth() - now.getUTCMonth());
  return months > 0 ? Math.round((months / 12) * 10) / 10 : 0;
}

/** Ordered feature labels: dictionary keys, then the broker's own extras. */
function featureLabels(l, lang = "ar") {
  const keys = l.feature_keys || [];
  const labels = keys.map((k) => Features.featureLabel(k, lang)).filter(Boolean);
  // Free-text extras are in the broker's words; English copy shows them only if they are Latin.
  const other = (l.features_other || []).filter((t) => lang !== "en" || !/[؀-ۿ]/.test(t));
  return [...labels, ...other];
}

const location = (l, lang) => {
  const compound = lang === "en" ? l.compound_en || l.details?.compound_en || latinOnly(l.compound) : l.compound || l.compound_en;
  const area = lang === "en" ? latinOnly(l.district) || latinOnly(l.city) : l.district || l.city;
  return [compound, compound ? null : area].filter(Boolean).join("، ") || (lang === "en" ? null : l.location || null);
};
const latinOnly = (s) => (s && !/[؀-ۿ]/.test(s) ? s : null);

/**
 * Payment lines (resale schedule, primary plans, rent). Only stated amounts appear.
 */
function paymentLines(l, lang = "ar", { now = new Date() } = {}) {
  const en = lang === "en";
  const cur = currencyOf(l);
  const lines = [];
  const pcase = Rules.paymentCase(l);
  const d = l.details || {};

  if (pcase === "resale_installments") {
    const paid = money(l.down_payment_value, lang, cur);
    const rem = money(l.remaining_amount, lang, cur);
    if (paid) lines.push(`💵 ${en ? "Paid / cash required" : "المدفوع (كاش مطلوب)"}: ${paid}`);
    if (rem) lines.push(`🏦 ${en ? "Remaining installments" : "المتبقي أقساط"}: ${rem}`);
    const inst = money(l.installment_value, lang, cur);
    const freq = frequencyLabel(l.payment_frequency, lang);
    const yrs = yearsLeft(l, now);
    const sched = [
      inst && (freq ? `${en ? "installment" : "قسط"} ${freq} ${inst}` : `${en ? "installment" : "قسط"} ${inst}`),
      !inst && freq && (en ? `${freq} installments` : `أقساط ${freq}`),
      yrs !== null && yrs > 0 && (en ? `${yrs} years left` : `باقي ${yrs} ${yrs <= 10 && yrs >= 3 ? "سنين" : "سنة"}`)
    ].filter(Boolean);
    if (sched.length) lines.push(`📆 ${sched.join(" · ")}`);
  } else if (pcase === "primary") {
    const plans = (l.payment_terms?.plans || []).filter((p) => known(p.down_payment_pct) || known(p.years));
    const cash = money(l.payment_terms?.cash_price, lang, cur);
    if (cash) lines.push(`💵 ${en ? "Cash price" : "سعر الكاش"}: ${cash}`);
    for (const p of plans.slice(0, 4)) lines.push(`💳 ${planHint(p, lang)}`);
    const maint = maintenanceText(l, lang);
    if (maint) lines.push(`🛠️ ${en ? "Maintenance" : "الصيانة"}: ${maint}`);
  }

  for (const [k, ar, enLabel] of [
    ["over_price", "الأوفر", "Over price"],
    ["club_fee", "رسوم النادي", "Club fee"],
    ["transfer_fee", "رسوم التنازل", "Transfer fee"]
  ]) {
    const m = money(d[k], lang, cur);
    if (m) lines.push(`➕ ${en ? enLabel : ar}: ${m}`);
  }
  const maintFee = money(d.maintenance_fee, lang, cur);
  if (maintFee) {
    const state = d.maintenance_paid === true ? (en ? "paid" : "مدفوعة") : d.maintenance_paid === false ? (en ? "due on delivery" : "عند الاستلام") : null;
    lines.push(`🛠️ ${en ? "Maintenance deposit" : "وديعة الصيانة"}: ${maintFee}${state ? ` (${state})` : ""}`);
  }
  return lines;
}

/** "مقدم 10% · 8 سنين" (+ frequency when stated). */
function planHint(p, lang = "ar") {
  const en = lang === "en";
  const bits = [];
  if (known(p.down_payment_pct)) bits.push(en ? `${num(p.down_payment_pct)}% down` : `مقدم ${num(p.down_payment_pct)}%`);
  const y = num(p.years);
  if (y === 0) bits.push(en ? "cash" : "كاش");
  else if (y) bits.push(en ? `${y} years` : `${y} ${y >= 3 && y <= 10 ? "سنين" : "سنة"}`);
  const f = frequencyLabel(p.frequency, lang);
  if (f && y) bits.push(f);
  return bits.join(" · ");
}

/** Maintenance terms: stated % or text; unknown reads "حسب التعاقد" (never an invented 8%). */
function maintenanceText(l, lang = "ar") {
  const pct = num(l.maintenance_pct);
  if (pct !== null && pct > 0) return `${pct}%`;
  if (l.payment_terms?.maintenance_terms) return l.payment_terms.maintenance_terms;
  return lang === "en" ? "as per contract" : "حسب التعاقد";
}

/**
 * Every captured, non-internal fact as display lines (shared by the broker card, the review card
 * and the client copy). Unknown fields are skipped.
 */
function factLines(l, lang = "ar") {
  const en = lang === "en";
  const d = l.details || {};
  const lines = [];
  const loc = location(l, lang);
  const headline = [typeLabel(l, lang), isRent(l) ? (en ? "for rent" : "للإيجار") : en ? "for sale" : "للبيع", loc && (en ? `in ${loc}` : `في ${loc}`)]
    .filter(Boolean)
    .join(" ");
  lines.push(`🏠 ${headline}`);

  const project = [
    d.project && `${en ? "Project" : "المشروع"}: ${en ? latinOnly(d.project) || null : d.project}`,
    d.developer && `${en ? "Developer" : "المطور"}: ${en ? latinOnly(d.developer) || null : d.developer}`
  ].filter((x) => x && !/: null$/.test(x));
  if (project.length) lines.push(`🏗️ ${project.join(" · ")}`);

  const price = priceLabel(l, lang);
  if (price) lines.push(`💰 ${price}`);
  lines.push(...paymentLines(l, lang));

  // Delivery is highlighted next to rooms and bathrooms when known.
  const delivery = Delivery.formatDelivery(l, lang);
  const specs = [areaLabel(l, lang), bedsLabel(l, lang), bathsLabel(l, lang)].filter(Boolean);
  if (specs.length || delivery) lines.push([specs.length && `📐 ${specs.join(" · ")}`, delivery].filter(Boolean).join(" · "));
  const land = num(d.land_area);
  const extras = [
    land && `${en ? "Land" : "الأرض"} ${land}${en ? "m²" : "م"}`,
    num(d.garden_area) && `${en ? "Garden" : "جنينة"} ${num(d.garden_area)}${en ? "m²" : "م"}`,
    num(d.roof_area) && `${en ? "Roof" : "روف"} ${num(d.roof_area)}${en ? "m²" : "م"}`
  ].filter(Boolean);
  if (extras.length) lines.push(`🌳 ${extras.join(" · ")}`);

  const finish = [floorLabel(l, lang), finishingLabel(l, lang), furnishingLabel(l, lang)].filter(Boolean);
  if (finish.length) lines.push(`🏢 ${finish.join(" · ")}`);

  const feats = featureLabels(l, lang);
  if (feats.length) lines.push(`✨ ${feats.join(" · ")}`);
  return lines;
}

/** Internal-only lines (owner, notes, commission, co-broker): broker card only. */
function internalLines(l, lang = "ar") {
  const d = l.details || {};
  const en = lang === "en";
  return [
    d.owner_name && `👤 ${en ? "Owner" : "المالك"}: ${d.owner_name}`,
    d.owner_phone && `📞 ${en ? "Owner phone" : "تليفون المالك"}: ${d.owner_phone}`,
    d.owner_lead && `🔗 ${en ? "Owner is client" : "المالك عميل"} ${d.owner_lead}`,
    d.commission && `💼 ${en ? "Commission" : "العمولة"}: ${d.commission}`,
    d.co_broker && `🤝 ${en ? "Co-broker" : "وسيط مشارك"}: ${d.co_broker}`,
    d.unit_no && `🔢 ${en ? "Unit no." : "رقم الوحدة"}: ${d.unit_no}`,
    d.address && `🏠 ${en ? "Address" : "العنوان"}: ${d.address}`,
    l.lat != null && l.lng != null && `📍 https://maps.google.com/?q=${l.lat},${l.lng}`,
    d.notes && `📝 ${en ? "Notes" : "ملاحظات"}: ${d.notes}`
  ].filter(Boolean);
}

const STATUS_LABELS = { active: ["🟢 متاحة", "🟢 Available"], sold: ["🔴 مباعة", "🔴 Sold"], archived: ["📁 مؤرشفة", "📁 Archived"], draft: ["📝 مسودة", "📝 Draft"] };

function confirmedLine(l, lang = "ar") {
  if (!l.confirmed_at) return null;
  const dt = new Date(l.confirmed_at);
  if (Number.isNaN(dt.getTime())) return null;
  const s = `${String(dt.getDate()).padStart(2, "0")}/${String(dt.getMonth() + 1).padStart(2, "0")}`;
  return `✅ ${lang === "en" ? "Confirmed" : "مؤكدة"} ${s}`;
}

/** Broker card: code, status, every fact, internal data. */
function brokerCard(l, { lang = "ar" } = {}) {
  const status = pick(STATUS_LABELS[l.status || "active"], lang);
  const head = [`🔑 \`${l.code}\``, status, confirmedLine(l, lang)].filter(Boolean).join(" · ");
  return [head, ...factLines(l, lang), ...internalLines(l, lang)].join("\n");
}

/**
 * Add/edit review card: the broker card plus what is missing (blockers) and the field warnings.
 * This is the ONLY surface that shows warnings.
 */
function reviewCard(l, { warnings = [], blockers = [], lang = "ar" } = {}) {
  const en = lang === "en";
  const lines = [en ? "📋 *Review before saving*" : "📋 *مراجعة قبل الحفظ*", `🔑 \`${l.code}\``, ...factLines(l, lang), ...internalLines(l, lang)];
  if (blockers.length) {
    lines.push("", en ? "⛔ *Still needed to save:*" : "⛔ *ناقص لإتمام الحفظ:*", ...blockers.map((b) => Rules.blockerLine(b, lang)));
    const onlyQuestion = blockers.every((b) => b.field === "installments_question");
    lines.push(
      onlyQuestion
        ? en ? "Tap an answer below." : "اختار الإجابة من الأزرار."
        : en ? "Send the missing details (text or voice), then tap Review." : "ابعت الناقص (كتابة أو فويس) واضغط مراجعة."
    );
  }
  if (warnings.length) lines.push("", ...warnings.map((w) => Rules.warningLine(w, lang)));
  if (!blockers.length) {
    lines.push("", en ? "Tap *Confirm & Save*, or *Edit* to add details." : "اضغط *تأكيد وحفظ*، أو *تعديل* لإضافة تفاصيل.");
  }
  return lines.join("\n");
}

/** Confirmation after a save: one message, the broker card. */
function savedCard(l, { lang = "ar" } = {}) {
  return `${lang === "en" ? "✅ *Saved*" : "✅ *تم الحفظ*"}\n${brokerCard(l, { lang })}`;
}


/* ---------------------------------------------------------------------- */
/* Client copy (forwardable): every captured fact, nothing internal        */
/* ---------------------------------------------------------------------- */

const SUMMARY_SCRUB = [
  /https?:\/\/\S+/gi,
  /wa\.me\/\S+/gi,
  /(?:\+?20|0)?1[0125]\d{8}\b/g,
  /(?:للتواصل|للاستفسار|اتصل|كلمنا|call us|contact us)[^\n]*/gi
];
function cleanSummary(text) {
  let t = String(text || "");
  for (const re of SUMMARY_SCRUB) t = t.replace(re, "");
  return t.replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim();
}

function contactLines(broker = {}, lang = "ar") {
  const en = lang === "en";
  const phone = String(broker.contact_phone || broker.phone_normalized || broker.phone_number || "").replace(/[^\d+]/g, "");
  const lines = [en ? "📞 *For viewings and details:*" : "📞 *للمعاينة والاستفسار:*"];
  if (broker.name) lines.push(`👤 ${broker.name}`);
  if (phone) lines.push(`📱 ${phone.startsWith("+") ? phone : `+${phone}`}`);
  return lines;
}

/**
 * Client copy (Arabic or English). English contains no Arabic script except proper names
 * the broker typed only in Arabic are dropped rather than shown untranslated.
 */
function clientCopy(l, broker = {}, { lang = "ar" } = {}) {
  const en = lang === "en";
  const [headline, ...facts] = factLines(l, lang);
  const summary = cleanSummary(en ? l.details?.summary_en : l.details?.clean_summary);
  return [
    `*${headline.replace(/^🏠 /, "🏠 ")}*`,
    `🏷️ ${en ? "Code" : "كود"}: \`${l.code}\``,
    ...facts,
    summary && (!en || !/[؀-ۿ]/.test(summary)) ? `\n📝 ${summary}` : null,
    "",
    ...contactLines(broker, lang)
  ]
    .filter((x) => x !== null && x !== undefined)
    .join("\n");
}

/* ---------------------------------------------------------------------- */
/* Search result: compact line + features line (identical on every surface) */
/* ---------------------------------------------------------------------- */

/** Payment hint for the compact line: كاش / مقدم 10% · 8 سنين / متبقي 1.2M. */
function paymentHint(l, lang = "ar") {
  const en = lang === "en";
  const pcase = Rules.paymentCase(l);
  if (pcase === "rent") return null;
  if (pcase === "resale_cash") return en ? "cash" : "كاش";
  if (pcase === "resale_installments") {
    const rem = money(l.remaining_amount, "en", currencyOf(l));
    return rem ? `${en ? "remaining" : "متبقي"} ${rem.replace(/ EGP$/, "")}` : en ? "installments" : "أقساط";
  }
  const plan = (l.payment_terms?.plans || []).find((p) => known(p.down_payment_pct) || known(p.years));
  if (plan) return planHint({ ...plan, frequency: null }, lang);
  return l.payment_terms?.cash_price ? (en ? "cash" : "كاش") : null;
}

const FEATURES_LINE_MAX = 4;

/** Line 2: features, cut with "+N" when long. */
function featuresLine(l, lang = "ar", max = FEATURES_LINE_MAX) {
  const labels = featureLabels(l, lang);
  if (!labels.length) return null;
  const shown = labels.slice(0, max);
  const rest = labels.length - shown.length;
  return shown.join(" · ") + (rest > 0 ? ` +${rest}` : "");
}

/** Line 1: code · type · compound · price · area · 🛏 · 🛁 · 🗓 · payment hint · ✅ date. */
function compactLine(l, lang = "ar") {
  const en = lang === "en";
  const beds = kindOf(l) === "studio" || kindOf(l) === "commercial" ? null : num(l.bedrooms);
  const baths = num(l.bathrooms);
  const delivery = Delivery.formatDelivery(l, lang);
  const conf = confirmedLine(l, lang)?.replace(/ (مؤكدة|Confirmed)/, "");
  const loc = en ? l.compound_en || l.details?.compound_en || latinOnly(l.compound) : l.compound || l.compound_en || l.district;
  return [
    `\`${l.code}\``,
    typeLabel(l, lang),
    loc,
    priceLabel(l, lang),
    areaLabel(l, lang),
    beds && beds > 0 ? `🛏 ${beds}` : null,
    baths && baths > 0 ? `🛁 ${baths}` : null,
    delivery ? delivery.replace(en ? /Delivery /i : /تسليم /, "") : null,
    paymentHint(l, lang),
    conf
  ]
    .filter(Boolean)
    .join(" · ");
}

/** One search result: the compact line and (when any) the features line. */
function searchResult(l, lang = "ar") {
  const f = featuresLine(l, lang);
  return f ? `${compactLine(l, lang)}\n   ✨ ${f}` : compactLine(l, lang);
}

/**
 * One search result as a short card for the bot: what and where with the code, then price and size, then delivery,
 * payment and when it was confirmed, then the features. Empty lines are left out.
 */
function resultCard(l, lang = "ar") {
  const en = lang === "en";
  const beds = kindOf(l) === "studio" || kindOf(l) === "commercial" ? null : num(l.bedrooms);
  const baths = num(l.bathrooms);
  const delivery = Delivery.formatDelivery(l, lang);
  const conf = confirmedLine(l, lang)?.replace(/ (مؤكدة|Confirmed)/, "");
  const loc = en ? l.compound_en || l.details?.compound_en || latinOnly(l.compound) : l.compound || l.compound_en || l.district;
  const join = (parts) => parts.filter(Boolean).join(" · ");
  const head = join([`🏠 ${typeLabel(l, lang)}`, loc, `\`${l.code}\``]);
  const size = join([priceLabel(l, lang) ? `💰 ${priceLabel(l, lang)}` : null, areaLabel(l, lang) ? `📐 ${areaLabel(l, lang)}` : null, beds && beds > 0 ? `🛏 ${beds}` : null, baths && baths > 0 ? `🛁 ${baths}` : null]);
  const terms = join([delivery ? `🗓 ${delivery.replace(en ? /Delivery /i : /تسليم /, "")}` : null, paymentHint(l, lang), conf]);
  const f = featuresLine(l, lang);
  return [head, size, terms && !terms.startsWith("🗓") ? `💳 ${terms}` : terms, f ? `✨ ${f}` : null].filter(Boolean).join("\n   ");
}

/** A page of search results with numbering and the footer hint. */
function searchResults(rows = [], { offset = 0, total = 0, lang = "ar" } = {}) {
  const en = lang === "en";
  const count = Number(total) || Number(rows[0]?.total_count) || rows.length;
  const out = [en ? `🔍 ${count} matching unit(s)` : `🔍 ${count} وحدة مطابقة`, ""];
  rows.forEach((r, i) => out.push(`${offset + i + 1}. ${resultCard(r, lang)}`, ""));
  const more = offset + rows.length < count;
  out.push(
    more
      ? en
        ? "Send a code for details · tap More for the next results"
        : "ابعت الكود للتفاصيل · اضغط المزيد لباقي النتائج"
      : en
      ? "Send a code for full details"
      : "ابعت الكود لعرض التفاصيل كاملة"
  );
  return out.join("\n");
}

/* ---------------------------------------------------------------------- */
/* Plan copy (one payment plan, forwardable)                                */
/* ---------------------------------------------------------------------- */

const exact = (n, lang) => `${Math.round(Number(n)).toLocaleString("en-US")} ${lang === "en" ? "EGP" : "ج.م"}`;

function planCopy(l, broker = {}, planIdOrYears = null, { lang = "ar" } = {}) {
  const F = require("../lib/financials");
  const en = lang === "en";
  const price = num(l.price_value) || 0;
  const plans = l.payment_terms?.plans || [];
  const raw =
    plans.find((p) => String(p.plan_id) === String(planIdOrYears) || String(p.years) === String(planIdOrYears)) || plans[0];
  if (!raw || !price) return "";
  const terms = F.maintenanceTerms(raw, l);
  const plan = F.calculatePlanSummary(price, { ...raw, maintenance_pct: terms.pct, maintenance_due: terms.due });

  const [headline, ...facts] = factLines({ ...l, payment_terms: {} }, lang);
  const years = plan.years;
  const name = years === 0 ? (en ? "Cash" : "كاش") : en ? `${years}-year plan` : `${years} ${years >= 3 && years <= 10 ? "سنين" : "سنة"}`;
  const lines = [
    `*${headline}*`,
    `🏷️ ${en ? "Code" : "كود"}: \`${l.code}\``,
    // Price and payment are restated below for this plan.
    ...facts.filter((x) => !/^(💰|💵|💳|🛠️|🏦|📆)/u.test(x)),
    "",
    `💳 *${en ? "Payment plan" : "نظام السداد"}: ${name}${plan.discount_pct > 0 ? (en ? ` (${plan.discount_pct}% off)` : ` (خصم ${plan.discount_pct}%)`) : ""}*`,
    `• ${en ? "Price" : "السعر"}: ${exact(price, lang)}`
  ];
  if (plan.discount_pct > 0) lines.push(`• ${en ? "After discount" : "بعد الخصم"}: ${exact(plan.effective_price, lang)}`);
  if (years === 0) {
    lines.push(`• ${en ? "Cash payment" : "الدفع كاش"}: ${exact(plan.effective_price, lang)}`);
  } else {
    lines.push(`• ${en ? "Down payment" : "المقدم"} (${plan.down_payment_pct}%): ${exact(plan.down_payment, lang)}`);
    for (const m of plan.milestones) lines.push(`• ${m.label}: ${exact(m.amount, lang)}`);
    lines.push(
      `• ${en ? `Installment (${frequencyLabel(plan.frequency, "en")})` : `القسط ${frequencyLabel(plan.frequency, "ar")}`}: ${exact(plan.installment_amount, lang)} × ${plan.total_installments_count}`
    );
  }
  if (terms.pct) {
    const due = terms.due === "installments" ? (en ? "with installments" : "مع الأقساط") : en ? "on delivery" : "عند الاستلام";
    lines.push(`• ${en ? "Maintenance" : "الصيانة"} (${terms.pct}%): ${exact(plan.total_maintenance, lang)} (${due})`);
  } else {
    lines.push(`• ${en ? "Maintenance" : "الصيانة"}: ${maintenanceText(l, lang)}`);
  }
  lines.push("", ...contactLines(broker, lang));
  return lines.join("\n");
}

/* ---------------------------------------------------------------------- */
/* Flyer model: the data the flyer renders (no layout, no warnings)          */
/* ---------------------------------------------------------------------- */

function flyerModel(l, { agency = {}, broker = null, lang = "en" } = {}) {
  const d = l.details || {};
  const en = lang === "en";
  const specs = [
    areaLabel(l, lang) && { icon: "area", label: areaLabel(l, lang) },
    num(d.land_area) && { icon: "land", label: `${en ? "Land" : "الأرض"} ${num(d.land_area)}${en ? "m²" : "م"}` },
    bedsLabel(l, lang) && { icon: "bed", label: bedsLabel(l, lang) },
    bathsLabel(l, lang) && { icon: "bath", label: bathsLabel(l, lang) },
    floorLabel(l, lang) && { icon: "floor", label: floorLabel(l, lang) },
    finishingLabel(l, lang) && { icon: "finishing", label: finishingLabel(l, lang) },
    Delivery.formatDelivery(l, lang, { icon: false }) && { icon: "delivery", label: Delivery.formatDelivery(l, lang, { icon: false }) }
  ].filter(Boolean);
  return {
    code: l.code,
    lang,
    title: en ? d.title_en || null : l.title || null,
    type: typeLabel(l, lang),
    purpose: isRent(l) ? (en ? "For rent" : "للإيجار") : en ? "For sale" : "للبيع",
    location: location(l, lang),
    price: priceLabel(l, lang),
    payment: paymentLines(l, lang).map((x) => x.replace(/^\S+\s/, "")),
    specs,
    features: featureLabels(l, lang),
    agency: { name: agency.name || null, logo_url: agency.logo_url || null, phone: agency.phone || null },
    contact: broker
      ? { name: broker.name || null, phone: String(broker.contact_phone || broker.phone_normalized || broker.phone_number || "") || null }
      : null
  };
}

module.exports = {
  clientCopy,
  paymentHint,
  featuresLine,
  compactLine,
  resultCard,
  searchResult,
  searchResults,
  planCopy,
  flyerModel,
  cleanSummary,
  TYPE_LABELS,
  FINISHING_LABELS,
  FREQUENCY_LABELS,
  money,
  typeLabel,
  priceLabel,
  areaLabel,
  bedsLabel,
  bathsLabel,
  floorLabel,
  finishingLabel,
  furnishingLabel,
  frequencyLabel,
  yearsLeft,
  featureLabels,
  paymentLines,
  planHint,
  maintenanceText,
  factLines,
  internalLines,
  brokerCard,
  reviewCard,
  savedCard
};
