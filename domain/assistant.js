// domain/assistant.js — The assistant's rules (Release B, C10 + N1), pure: the "ask" command, which parts of the
// agency's data a question needs (projects named in it, the broker's clients, follow-ups, units), the grounded prompt
// (answer only from the data given, with its date; otherwise say it is not in our data), reading the answer, and the
// label every web answer carries. Nothing here guesses: data the question did not need is simply not sent.
"use strict";

const { normalizeSearch } = require("./searchText");

const MAX_QUESTION = 500;
const ASK = /^(?:اسأل|إسأل|اسال|سؤال|سوال|يا مساعد|ask|question)\s*[:：\-,،]?\s+(.+)$/is;
const CLIENT_WORDS = /(عميل|عملا|عملائ|زبون|زباين|كلاينت|ليد|client|lead|customer|بيدور|عايز|طالب|طلب)/i;
const FOLLOW_WORDS = /(متابع|معاين|النهارد|انهارد|بكر|النهاردة|مواعيد|ميعاد|المطلوب مني|ورايا|اعمل ايه|today|tomorrow|due|follow|viewing|task)/i;
const UNIT_WORDS = /(وحد|شق|فيل|دوبلكس|تاون|توين|شاليه|بنتهاوس|استوديو|محل|مكتب|متاح|عندنا|unit|apartment|villa|duplex|townhouse|chalet|penthouse|studio|available|listing)/i;

const NOT_FOUND = {
  ar: "مش موجود في بياناتنا.",
  en: "That's not in our data."
};
const WEB_LABEL = {
  ar: "🌐 من الإنترنت، غير مؤكد:",
  en: "🌐 From the web, unverified:"
};

/** "اسأل امتى استلام بادية؟" → the question | null. */
function matchAsk(text) {
  const m = String(text || "").trim().match(ASK);
  return m ? m[1].trim().slice(0, MAX_QUESTION) : null;
}

const langOf = (q) => (/[؀-ۿ]/.test(q) ? "ar" : "en");

/** Words of a name worth matching (2+ letters, normalized). */
const tokens = (s) => normalizeSearch(s).split(/\s+/).filter((w) => w.length >= 3);

/** Projects whose name (Arabic or English) or developer appears in the question. */
function matchProjects(question, projects) {
  const q = ` ${normalizeSearch(question)} `;
  return projects.filter((p) => [p.name, p.name_en].filter(Boolean).some((n) => {
    const t = normalizeSearch(n).trim();
    return t.length >= 3 && q.includes(t);
  }) || (p.developer_name && tokens(p.developer_name).some((w) => q.includes(` ${w} `))));
}

/** Leads whose name appears in the question. */
function matchLeads(question, leads) {
  const q = ` ${normalizeSearch(question)} `;
  return leads.filter((l) => l.name && tokens(l.name).some((w) => q.includes(` ${w} `) || q.includes(` ${w}`)));
}

/** What the question needs besides named projects: { clients, followups, units }. */
function scopesOf(question) {
  const q = normalizeSearch(question);
  return { clients: CLIENT_WORDS.test(q), followups: FOLLOW_WORDS.test(q), units: UNIT_WORDS.test(q) };
}

/** The grounded prompt. blocks = [{ title, as_of, text }]. */
function prompt(question, blocks, { lang, today }) {
  const data = blocks.length ? blocks.map((b) => `### ${b.title}${b.as_of ? ` (data as of ${b.as_of})` : ""}\n${b.text}`).join("\n\n") : "(no data)";
  return `You are the assistant of an Egyptian real-estate agency. Today is ${today}.
Answer the broker's question using ONLY the DATA below, which is the agency's own records.
Rules:
- Never assume, estimate or use outside knowledge. If the DATA does not contain the answer, set "found": false and write only: "${NOT_FOUND[lang]}" plus, if useful, what related information the DATA does have.
- When you use a fact, mention the date of its data block in the answer (for example "according to the price sheet of 2026-10-01").
- Keep it short and ready to forward to a client when the question is about a project or unit; never include internal notes, developer contacts or commissions in client-ready text unless the broker asks about them directly.
- Reply in ${lang === "en" ? "English" : "Egyptian Arabic"}.
Return JSON only: {"answer":"...","found":true|false}

DATA:
${data}

QUESTION: ${question}`;
}

/** The model's text → { answer, found } (unreadable answers count as not found). */
function parseAnswer(text, lang = "ar") {
  try {
    const d = JSON.parse(String(text || "").replace(/^```(?:json)?\s*|\s*```$/g, ""));
    const answer = String(d.answer || "").trim().slice(0, 2000);
    if (!answer) return { answer: NOT_FOUND[lang], found: false };
    return { answer, found: d.found !== false };
  } catch {
    return { answer: NOT_FOUND[lang], found: false };
  }
}

/** The web prompt: only used when the agency's data had no answer and the owner switched web search on. */
function webPrompt(question, { lang }) {
  return `Answer this question from an Egyptian real-estate broker using web search. Be brief (at most 4 sentences), state only what the sources say, and say so if the sources disagree or are old. Reply in ${lang === "en" ? "English" : "Egyptian Arabic"}.
QUESTION: ${question}`;
}

/** Source links from Gemini's grounding metadata: [{ title, url }] (https only, unique, up to 5). */
function webSources(grounding) {
  const out = [];
  const seen = new Set();
  for (const c of grounding?.groundingChunks || []) {
    const url = c?.web?.uri;
    if (!url || !/^https:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    out.push({ title: String(c.web.title || url).slice(0, 120), url });
    if (out.length >= 5) break;
  }
  return out;
}

module.exports = { MAX_QUESTION, NOT_FOUND, WEB_LABEL, matchAsk, langOf, matchProjects, matchLeads, scopesOf, prompt, parseAnswer, webPrompt, webSources };
