// domain/winLoss.js — Win and loss reasons (Release B, N7), pure: the lost-reason categories (the bot's reason list
// plus free text typed on the website or said by voice), a keyword classifier for free text, and win rate.
"use strict";

const REASONS = {
  price: ["السعر", "Price"],
  location: ["المكان", "Location"],
  elsewhere: ["اشترى من مكان تاني", "Bought elsewhere"],
  financing: ["التمويل أو طريقة الدفع", "Financing or payment plan"],
  not_serious: ["مش جاد", "Not serious"],
  no_answer: ["مش بيرد", "Not answering"],
  other: ["سبب تاني", "Other"]
};

// Checked in order: the first that matches wins ("bought elsewhere because of the price" counts as elsewhere).
const RULES = [
  ["elsewhere", /(مكان تاني|حتة تانية|بروكر تاني|سمسار تاني|شركة تانية|اشترى|اشتري|اشترت|اتعامل مع|elsewhere|another (?:broker|agency|company)|competitor|bought)/i],
  ["no_answer", /(مش بيرد|مبيردش|ما بيردش|مش بترد|لا يرد|مقفول|no answer|not answering|unreachable|doesn'?t answer)/i],
  ["not_serious", /(مش جاد|غير جاد|بيتفرج|بيسأل بس|not serious|just looking|time ?waster)/i],
  ["financing", /(تمويل|قسط|أقساط|اقساط|مقدم|طريقة الدفع|بنك|financ|mortgage|installment|down ?payment|payment plan)/i],
  ["price", /(سعر|السعر|غالي|غالية|ميزاني|فلوس|price|expensive|budget|costly|afford)/i],
  ["location", /(مكان|المكان|منطقة|المنطقة|بعيد|بعيدة|لوكيشن|location|area|far|neighbou?rhood)/i]
];

/** A lost reason (any wording) → a category key. */
function classify(reason) {
  const r = String(reason || "").trim();
  if (!r) return "other";
  const exact = Object.entries(REASONS).find(([, [ar, en]]) => r === ar || r.toLowerCase() === en.toLowerCase());
  if (exact) return exact[0];
  const hit = RULES.find(([, re]) => re.test(r));
  return hit ? hit[0] : "other";
}

const label = (key, lang) => (REASONS[key] || REASONS.other)[lang === "en" ? 1 : 0];
const winRate = (won, lost) => (won + lost ? Math.round((won / (won + lost)) * 100) : null);

module.exports = { REASONS, classify, label, winRate };
