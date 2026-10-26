// domain/brochure.js — A project's brochure (Release B, C6), pure: the facts read from each brochure page (what the
// page states, sorted by topic, never inferred), the 3 to 5 highlight lines suggested from those facts in Arabic and
// English, and the managers' edited lines. The facts are kept on the project as part of its stored context for the
// project assistant (C10); the highlights show on the project page and the client's unit page.
"use strict";

const MAX_LINES = 5;
const MAX_LINE = 140;
const MAX_PAGES = 8;
const MAX_FACTS = 120;
const FACTS_VERSION = "facts-v1";
const TOPICS = ["developer", "location", "units", "amenities", "delivery", "finishing", "payment", "other"];

const FACTS_PROMPT = `You read ONE page of an Egyptian real-estate project's brochure (a PDF page or a photo).
Return JSON only: {"facts":[{"topic":"...","text":"..."}]}.
- Each fact is one short sentence that the page states plainly (names, places, distances, areas, unit types, amenities, delivery dates, finishing, payment terms).
- topic is one of: ${TOPICS.join(", ")}.
- Copy numbers exactly as written. Never guess, generalise or add anything the page does not say. Skip slogans with no fact in them.
- Write each fact in the page's language.
If the page has no facts, return {"facts":[]}.`;

/** The highlight prompt over the stored facts (text only). */
function highlightsPrompt(project, facts) {
  const list = facts.map((f) => `- [${f.topic}] ${f.text}`).join("\n");
  return `Project: ${project.name}${project.developer_name ? ` by ${project.developer_name}` : ""}.
Facts from its brochure:
${list}

Write 3 to 5 short selling highlights for a buyer, each under 120 characters, using ONLY these facts (no claims, numbers or adjectives that the facts do not support).
Return JSON only: {"ar":["..."],"en":["..."]} with the same highlights in Egyptian Arabic and in English.`;
}

const clean = (s, max) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const parseJson = (text) => {
  try {
    return JSON.parse(String(text || "").replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    return null;
  }
};

/** One page's answer → { result: [{ topic, text }] } | { error }. */
function factsFromAnswer(text) {
  const data = parseJson(text);
  const list = Array.isArray(data?.facts) ? data.facts : Array.isArray(data) ? data : null;
  if (!list) return { error: "AI_BAD_JSON" };
  const result = [];
  for (const f of list.slice(0, 40)) {
    const t = clean(f?.text, 240);
    if (!t) continue;
    result.push({ topic: TOPICS.includes(f?.topic) ? f.topic : "other", text: t });
  }
  return { result };
}

/** The highlights answer → { ar, en } (each up to 5 lines) | { error }. */
function linesFromAnswer(text) {
  const data = parseJson(text);
  if (!data || (!Array.isArray(data.ar) && !Array.isArray(data.en))) return { error: "AI_BAD_JSON" };
  const take = (a) => (Array.isArray(a) ? a.map((l) => clean(l, MAX_LINE)).filter(Boolean).slice(0, MAX_LINES) : []);
  return { ar: take(data.ar), en: take(data.en) };
}

/** A manager's textarea (one line each) → lines | { error }. */
function linesFromText(input) {
  const lines = String(input ?? "")
    .split(/\r?\n/)
    .map((l) => clean(l.replace(/^\s*(?:[-•*]|\d{1,2}[.)])\s*/, ""), 1000))
    .filter(Boolean);
  if (lines.length > MAX_LINES) return { error: "too_many_lines" };
  if (lines.some((l) => l.length > MAX_LINE)) return { error: "line_too_long" };
  return lines;
}

/** Facts from several pages, without repeats, capped. */
function mergeFacts(pages) {
  const seen = new Set();
  const out = [];
  for (const facts of pages) {
    for (const f of facts || []) {
      const key = `${f.topic}|${f.text.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(f);
      if (out.length >= MAX_FACTS) return out;
    }
  }
  return out;
}

/** The highlights to show in a language: that language, else Arabic, else English. */
function highlightsFor(h, lang = "ar") {
  const x = h && typeof h === "object" ? h : {};
  const pick = (k) => (Array.isArray(x[k]) ? x[k].filter(Boolean) : []);
  return lang === "en" ? (pick("en").length ? pick("en") : pick("ar")) : pick("ar").length ? pick("ar") : pick("en");
}

module.exports = { MAX_LINES, MAX_LINE, MAX_PAGES, FACTS_VERSION, TOPICS, FACTS_PROMPT, highlightsPrompt, factsFromAnswer, linesFromAnswer, linesFromText, mergeFacts, highlightsFor };
