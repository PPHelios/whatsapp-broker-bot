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

/** Contacting a new lead moves it to contacted; later stages stay. */
const stageAfterContact = (stage) => (stage === "new" ? "contacted" : stage);

module.exports = {
  STAGES,
  CLOSED,
  KINDS,
  WANTS_UNIT,
  LAWFUL_BASES,
  FOLLOW_UP_KINDS,
  stageLabel,
  kindLabel,
  basisLabel,
  isClosed,
  stageError,
  stageAfterContact
};
