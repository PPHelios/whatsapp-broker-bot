// domain/planReading.js — A developer's payment plans file (F21), pure: the prompt that reads one page (PDF page,
// photo, or an Excel/CSV sheet as text) into payment plans, and the answer checked into plan form fields. Nothing is
// saved from here: the manager ticks and edits the plans in a preview first (services/planReading.js).
"use strict";

const MAX_PAGES = 8;
const MAX_PLANS = 12;
const VERSION = "plans-v1";
const FREQUENCIES = ["monthly", "quarterly", "semi_annual", "annual"];
const DUE = ["delivery", "installments", "contract"];

const PROMPT = `You read ONE page of an Egyptian real-estate developer's payment plans (a PDF page, a photo, or a sheet as text).
Return JSON only: {"plans":[{"name":"...","down_payment_pct":10,"years":8,"frequency":"quarterly","discount_pct":0,
"milestones":[{"pct":5,"due_after_months":12,"label":"..."}],"maintenance_pct":8,"maintenance_due":"delivery",
"extra_fees":[{"label":"Club","amount":150000}]}]}.
- One entry per payment plan the page offers. name: the plan's own name, or a short one like "10% / 8 years".
- frequency is one of: ${FREQUENCIES.join(", ")}. maintenance_due is one of: ${DUE.join(", ")}.
- years 0 means cash. Percentages are numbers (10, not "10%"). Amounts are whole Egyptian pounds.
- Copy numbers exactly as written. Leave out any field the page does not state; never guess.
If the page has no payment plans, return {"plans":[]}.`;

const clean = (s, max) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const pct = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 100 ? Number(v) : null);
const parseJson = (text) => {
  try {
    return JSON.parse(String(text || "").replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    return null;
  }
};

/** One plan from the model → the fields the plan form takes, or null when it has no down payment. */
function planOf(p) {
  const down = pct(p?.down_payment_pct);
  if (down === null) return null;
  const years = Number.isFinite(Number(p.years)) && Number(p.years) >= 0 && Number(p.years) <= 20 ? Number(p.years) : 0;
  const maint = pct(p.maintenance_pct);
  return {
    name: clean(p.name, 80) || `${down}% / ${years}`,
    down_payment_pct: down,
    years,
    frequency: FREQUENCIES.includes(p.frequency) ? p.frequency : "quarterly",
    discount_pct: pct(p.discount_pct) || 0,
    milestones: (Array.isArray(p.milestones) ? p.milestones : [])
      .map((m) => ({ pct: pct(m?.pct), due_after_months: Math.max(0, Math.round(Number(m?.due_after_months) || 0)), label: clean(m?.label, 60) || null }))
      .filter((m) => m.pct)
      .slice(0, 4),
    maintenance_pct: maint !== null && maint <= 30 ? maint : null,
    maintenance_due: DUE.includes(p.maintenance_due) ? p.maintenance_due : "delivery",
    extra_fees: (Array.isArray(p.extra_fees) ? p.extra_fees : [])
      .map((f) => ({ label: clean(f?.label, 60), amount: Math.round(Number(f?.amount) || 0) }))
      .filter((f) => f.label && f.amount > 0 && f.amount <= 1e9)
      .slice(0, 4)
  };
}

/** One page's answer → { result: [plan] } | { error }. */
function plansFromAnswer(text) {
  const data = parseJson(text);
  const list = Array.isArray(data?.plans) ? data.plans : Array.isArray(data) ? data : null;
  if (!list) return { error: "AI_BAD_JSON" };
  return { result: list.slice(0, MAX_PLANS).map(planOf).filter(Boolean) };
}

/** Plans from every page, the same plan (name, down payment and years) once. */
function mergePlans(pages) {
  const seen = new Set();
  const out = [];
  for (const p of pages.flat()) {
    const key = `${p.name.toLowerCase()}|${p.down_payment_pct}|${p.years}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out.slice(0, MAX_PLANS);
}

/** A plan → the body the plan form posts (services/catalogue.js planFields). */
function formInput(p) {
  return {
    name: p.name,
    down_payment_pct: String(p.down_payment_pct),
    years: String(p.years),
    frequency: p.frequency,
    discount_pct: String(p.discount_pct || 0),
    milestone_pct: p.milestones.map((m) => String(m.pct)),
    milestone_months: p.milestones.map((m) => String(m.due_after_months)),
    milestone_label: p.milestones.map((m) => m.label || ""),
    maintenance_pct: p.maintenance_pct === null ? "" : String(p.maintenance_pct),
    maintenance_due: p.maintenance_due,
    fee_label: p.extra_fees.map((f) => f.label),
    fee_amount: p.extra_fees.map((f) => String(f.amount))
  };
}

module.exports = { MAX_PAGES, MAX_PLANS, VERSION, PROMPT, plansFromAnswer, mergePlans, formInput };
