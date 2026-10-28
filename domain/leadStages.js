// domain/leadStages.js — The lead pipeline (Q4): stages, kinds, lawful bases and their rules (pure)
"use strict";

const STAGES = ["new", "contacted", "interested", "viewing", "negotiation", "won", "lost"];
const STAGE_LABELS = {
  new: ["🆕 جديد", "🆕 New"],
  contacted: ["📞 اتكلمنا", "📞 Contacted"],
  interested: ["👍 مهتم", "👍 Interested"],
  viewing: ["🏠 معاينة", "🏠 Viewing"],
  negotiation: ["🤝 تفاوض", "🤝 Negotiation"],
  won: ["✅ اتقفلت", "✅ Won"],
  lost: ["❌ ضاعت", "❌ Lost"]
};
const CLOSED = ["won", "lost"];

const KINDS = ["buyer", "tenant", "seller", "landlord"];
const KIND_LABELS = {
  buyer: ["مشتري", "Buyer"],
  tenant: ["مستأجر", "Tenant"],
  seller: ["بايع", "Seller"],
  landlord: ["مؤجر", "Landlord"]
};
// Buyers and tenants carry a request (step 7); sellers and landlords offer "➕ add their unit".
const WANTS_UNIT = ["buyer", "tenant"];

const LAWFUL_BASES = ["client_request", "consent", "existing_client"];
const BASIS_LABELS = {
  client_request: ["العميل طلب التواصل", "The client asked to be contacted"],
  consent: ["موافقة العميل", "The client's consent"],
  existing_client: ["عميل حالي للوكالة", "An existing client of the agency"]
};

const FOLLOW_UP_KINDS = ["call", "viewing"];

// Q12: a common list plus Other (free text); the stored value is the English name, any other text is kept as typed.
const SOURCES = [
  ["WhatsApp", "واتساب"],
  ["Facebook", "فيسبوك"],
  ["Instagram", "إنستجرام"],
  ["TikTok", "تيك توك"],
  ["Google", "جوجل"],
  ["OLX-Dubizzle", "أوليكس-دوبيزل"],
  ["Property Finder", "بروبرتي فايندر"],
  ["Referral", "ترشيح"],
  ["Walk-in", "زيارة المكتب"],
  ["Call", "مكالمة"],
  ["Unit link", "لينك وحدة"]
];
const sourceLabel = (source, lang) => {
  const hit = SOURCES.find(([en]) => en === source);
  return hit ? hit[lang === "en" ? 0 : 1] : source || "";
};
const LOST_REASON_MAX = 200;

const pick = (labels, key, lang) => (labels[key] ? labels[key][lang === "en" ? 1 : 0] : key);
const stageLabel = (stage, lang) => pick(STAGE_LABELS, stage, lang);
const kindLabel = (kind, lang) => pick(KIND_LABELS, kind, lang);
const basisLabel = (basis, lang) => pick(BASIS_LABELS, basis, lang);
const isClosed = (stage) => CLOSED.includes(stage);

/**
 * Checks a stage move (any stage may move to any other; lost needs a reason).
 * @returns {string|null} an error code (unknown_stage, lost_reason_required, lost_reason_too_long) or null
 */
function stageError(stage, lostReason) {
  if (!STAGES.includes(stage)) return "unknown_stage";
  if (stage === "lost") {
    const r = String(lostReason || "").trim();
    if (!r) return "lost_reason_required";
    if (r.length > LOST_REASON_MAX) return "lost_reason_too_long";
  }
  return null;
}

/** Cairo's offset from UTC in minutes at an instant (Egypt has summer time). */
function cairoOffsetMinutes(at) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "Africa/Cairo", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      .formatToParts(at)
      .map((x) => [x.type, x.value])
  );
  const local = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
  return Math.round((local - Math.floor(at.getTime() / 60000) * 60000) / 60000);
}

/** Q5: the instant that is `hour`:00 Cairo time, `daysAhead` Cairo days after `now` (a date with no time means 10:00). */
function cairoDayAt(now, daysAhead = 0, hour = 10) {
  const shifted = new Date(now.getTime() + cairoOffsetMinutes(now) * 60000);
  const base = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() + daysAhead, hour);
  const guess = new Date(base - 2 * 3600 * 1000);
  return new Date(base - cairoOffsetMinutes(guess) * 60000);
}

/** "2026-11-02T15:00" or "2026-11-02" (10:00) typed in Cairo time → the instant; null if invalid. */
function fromCairoLocal(text) {
  const m = String(text || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/);
  if (!m) return null;
  const base = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), m[4] === undefined ? 10 : Number(m[4]), m[5] === undefined ? 0 : Number(m[5]));
  if (Number.isNaN(base)) return null;
  const at = new Date(base - cairoOffsetMinutes(new Date(base - 2 * 3600 * 1000)) * 60000);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** F9: a date or time field's default: the next round hour (Cairo) as "YYYY-MM-DDTHH:00". */
function nextHourLocal(now = new Date()) {
  return toCairoLocal(new Date(Math.floor(now.getTime() / 3600000) * 3600000 + 3600000)).slice(0, 13) + ":00";
}

/** F9: today in Cairo as "YYYY-MM-DD". */
const cairoDay = (now = new Date()) => toCairoLocal(now).slice(0, 10);

/** An instant → "2026-11-02T15:00" in Cairo time (for datetime-local inputs). */
function toCairoLocal(at) {
  if (!at) return "";
  const d = new Date(at);
  return new Date(d.getTime() + cairoOffsetMinutes(d) * 60000).toISOString().slice(0, 16);
}

/** Contacting a new lead moves it to contacted; later stages stay. */
const stageAfterContact = (stage) => (stage === "new" ? "contacted" : stage);

module.exports = {
  STAGES,
  CLOSED,
  KINDS,
  WANTS_UNIT,
  LAWFUL_BASES,
  FOLLOW_UP_KINDS,
  SOURCES,
  sourceLabel,
  stageLabel,
  kindLabel,
  basisLabel,
  isClosed,
  stageError,
  stageAfterContact,
  cairoOffsetMinutes,
  cairoDayAt,
  fromCairoLocal,
  toCairoLocal,
  nextHourLocal,
  cairoDay
};
