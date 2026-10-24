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
  return pick(FINISHING_LABELS[l.finishing], lang);
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
    if (sched.length) lines.push(`🗓️ ${sched.join(" · ")}`);
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

  const price = priceLabel(l, lang);
  if (price) lines.push(`💰 ${price}`);
  lines.push(...paymentLines(l, lang));

  const specs = [areaLabel(l, lang), bedsLabel(l, lang), bathsLabel(l, lang)].filter(Boolean);
  if (specs.length) lines.push(`📐 ${specs.join(" · ")}`);
  const land = num(d.land_area);
  const extras = [
    land && `${en ? "Land" : "الأرض"} ${land}${en ? "m²" : "م"}`,
    num(d.garden_area) && `${en ? "Garden" : "جنينة"} ${num(d.garden_area)}${en ? "m²" : "م"}`,
    num(d.roof_area) && `${en ? "Roof" : "روف"} ${num(d.roof_area)}${en ? "m²" : "م"}`
  ].filter(Boolean);
  if (extras.length) lines.push(`🌳 ${extras.join(" · ")}`);

  const finish = [floorLabel(l, lang), finishingLabel(l, lang), furnishingLabel(l, lang)].filter(Boolean);
  if (finish.length) lines.push(`🏢 ${finish.join(" · ")}`);

  const delivery = Delivery.formatDelivery(l, lang);
  if (delivery) lines.push(delivery);

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
    d.commission && `💼 ${en ? "Commission" : "العمولة"}: ${d.commission}`,
    d.co_broker && `🤝 ${en ? "Co-broker" : "وسيط مشارك"}: ${d.co_broker}`,
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
    lines.push(en ? "Send the missing details (text or voice), then tap Review." : "ابعت الناقص (كتابة أو فويس) واضغط مراجعة.");
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

module.exports = {
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
