// services/projectAnswer.js — Ask answers from the project catalog when no unit matches a project's name. The answer uses the
// project's stored details and the lines of its notes that mention what was asked (a price, an area), and says when the data
// was last updated. Commission and plan rules are never read here.
"use strict";

const { normalizeSearch } = require("../domain/searchText");
const { normalizeDigits } = require("../lib/text");
const ProjectNotes = require("../domain/projectNotes");
const Offers = require("./projectOffers");
const { fuzzyMatch } = require("../domain/projectNames");
const MAX_OFFERS = 30; // a text message holds about this many lines; more are counted and the broker is asked to narrow the request

// Words that name a kind of place or unit, not a project: they must not match every project.
const GENERIC = new Set(
  [
    "ريزيدنس", "ريزدنس", "ريزيدنسز", "كمبوند", "كومبوند", "مشروع", "شقه", "شقة", "وحده", "وحدة", "عايز", "عاوز", "دور", "في", "فى", "من", "على", "عن",
    "متر", "مربع", "بدور", "ابحث", "هل", "فيه", "عندكم", "residence", "residences", "compound", "project", "apartment", "unit", "the", "in", "of",
    "for", "with", "sqm", "meter", "meters", "and", "or", "a", "an", "any", "under", "over", "budget", "installment", "installments", "قسط", "اقساط", "أقساط",
    "تقسيط", "مقدم", "ميزانيه", "ميزانية", "سعر", "بكام", "كام"
  ].map(normalizeSearch)
);

/** Words of the request that could name a project: letters only, at least three, not generic, not numbers. */
function nameWords(text) {
  const t = normalizeSearch(normalizeDigits(String(text || "")));
  return [...new Set(t.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 && !/^\d+$/.test(w) && !GENERIC.has(w)))];
}

/** The numbers the request names (110, 150 ...), used to pick the note lines that mention them. */
function requestNumbers(text) {
  return [...new Set((normalizeDigits(String(text || "")).match(/\d+(?:\.\d+)?/g) || []).map((n) => String(Number(n))))];
}

/** Projects whose Arabic or English name contains one of the request's words (accents and spelling variants folded). */
function matchProjects(projects, words) {
  if (!words.length) return [];
  const hits = [];
  for (const p of projects) {
    const names = [p.name, p.name_en].map((n) => normalizeSearch(n || ""));
    const score = words.filter((w) => names.some((n) => n.includes(w))).length;
    if (score) hits.push({ project: p, score });
  }
  return hits.sort((a, b) => b.score - a.score).map((h) => h.project);
}

/**
 * The note lines that answer the request. Lines are split where the notes separate offers (a line break, "__", or the fire emoji).
 * With numbers in the request, only the lines that mention one of them. Without numbers, the lines that name a payment plan.
 */
function noteLines(notes, numbers) {
  const parts = String(notes || "")
    .split(/\n|__|🔥/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 3);
  if (numbers.length) {
    const hit = parts.filter((s) => numbers.some((n) => new RegExp(`(^|[^\\d.])${n.replace(".", "\\.")}([^\\d]|$)`).test(normalizeDigits(s))));
    return hit.slice(0, 6);
  }
  return parts.filter((s) => /مقدم|تقسيط|قسط|payment|down/i.test(s)).slice(0, 3);
}

function formatDate(d) {
  if (!d) return null;
  const x = new Date(d);
  return Number.isNaN(x.getTime()) ? null : x.toISOString().slice(0, 10);
}

/** The reply text for one project, or null when the words name no project. */
function projectReply(project, text, lang = "ar") {
  const en = lang === "en";
  const lines = noteLines(project.notes, requestNumbers(text));
  const updated = formatDate(project.updated_at);
  const head = [
    `🏗️ *${project.name_en || project.name}*${project.name_en && project.name ? ` (${project.name})` : ""}`,
    project.developer_name ? (en ? `Developer: ${project.developer_name}` : `المطور: ${project.developer_name}`) : null,
    [project.district, project.city].filter(Boolean).length ? (en ? `Area: ${[project.district, project.city].filter(Boolean).join(", ")}` : `المنطقة: ${[project.district, project.city].filter(Boolean).join("، ")}`) : null,
    project.status || project.delivery_year
      ? en
        ? `Status: ${project.status || "-"}${project.delivery_year ? ", delivery " + project.delivery_year : ""}`
        : `الحالة: ${project.status || "-"}${project.delivery_year ? "، التسليم " + project.delivery_year : ""}`
      : null
  ].filter(Boolean);
  const body = lines.length
    ? [en ? "From the project notes:" : "من ملاحظات المشروع:", ...lines.map((l) => `• ${l}`)]
    : [en ? "The project notes have nothing on that yet." : "ملاحظات المشروع مفيهاش حاجة عن ده لسه."];
  const foot = [
    en
      ? "No units of this project are in the inventory yet, so this answer comes from the project catalog."
      : "مفيش وحدات للمشروع ده في المخزون لسه، فالرد ده من بيانات المشروع في الكتالوج.",
    updated ? (en ? `Last updated: ${updated}` : `آخر تحديث: ${updated}`) : en ? "Last updated: not recorded" : "آخر تحديث: غير مسجل"
  ];
  return [...head, "", ...body, "", ...foot].join("\n");
}

/**
 * Ask's catalog answer for a request that found no unit. Returns the reply text, or null when no project matches.
 * `text` is the request as typed; the project list is the agency's own, unarchived projects.
 */
async function answer(pool, agencyId, text, lang = "ar", filters = {}) {
  if (!pool) return null;
  const words = nameWords(text);
  const { rows } = await pool.query(
    "SELECT name, name_en, developer_name, district, city, status, delivery_year, notes, updated_at FROM projects WHERE agency_id = $1 AND archived_at IS NULL",
    [agencyId]
  );
  // A project named in the request: its own answer.
  const best = matchProjects(rows, words)[0] || fuzzyMatch(text, rows)[0];
  if (best) return projectReply(best, text, lang);
  // Otherwise: the offers written in the notes that fit the area, place, budget, installment or down payment asked.
  const projects = await Offers.projectsWithOffers(pool, agencyId);
  const all =ProjectNotes.matchUnits(projects, filters);
  const hits = all.slice(0, MAX_OFFERS);
  if (!hits.length) return sizesNotRecorded(projects, filters, lang);
  return notesReply(hits, lang, all.length);
}

/** No offer fits a size or bedroom request, but projects in the place asked have offers without sizes: say so, and name them. */
function sizesNotRecorded(projects, f, lang = "ar") {
  if (f.area_min == null && f.area_max == null) return null;
  const places = [...(f.locations || []), ...(f.place_terms || [])].map((p) => normalizeSearch(p)).filter(Boolean);
  if (!places.length) return null;
  const names = projects.filter(({ project, units }) => ProjectNotes.matchesPlace(project, places) && units.some((u) => u.area == null)).map(({ project }) => (project.name_en ? `${project.name} (${project.name_en})` : project.name));
  if (!names.length) return null;
  const list = names.slice(0, 5).join(lang === "en" ? ", " : "، ");
  return lang === "en" ? `Not in our data. We have ${list} there, but its unit sizes are not recorded.` : `مش موجود في بياناتنا. عندنا ${list} بس مش متسجل مساحات الشقق فيه.`;
}

/** The reply for offers taken from notes: one line each, with the newest update date of the projects shown. */
function notesReply(hits, lang = "ar", total = hits.length) {
  const en = lang === "en";
  const money = (n) => (n == null ? "-" : Number(n).toLocaleString("en-US"));
  const lines = hits.map(({ project, unit }) => {
    const name = project.name_en || project.name;
    const bits = [
      unit.area != null ? `${unit.area} m²${unit.floor ? (en ? `, floor ${unit.floor}` : `، الدور ${unit.floor}`) : ""}` : en ? "size not written" : "المساحة مش مكتوبة",
      `${money(unit.price)} ${en ? "EGP" : "جنيه"}`,
      unit.down != null ? (en ? `down ${money(unit.down)}` : `مقدم ${money(unit.down)}`) : null,
      unit.monthly == null && unit.monthly_est != null ? (en ? `≈${money(unit.monthly_est)}/month (calculated, no interest)` : `≈${money(unit.monthly_est)} شهريًا (حساب تقريبي بدون فوايد)`) : null,
      unit.monthly != null ? (en ? `${money(unit.monthly)}/month${unit.years ? " for " + unit.years + " years" : ""}` : `قسط ${money(unit.monthly)} شهريًا${unit.years ? " على " + unit.years + " سنين" : ""}`) : null
    ].filter(Boolean);
    return `• *${name}*: ${bits.join(" · ")}`;
  });
  const updated = hits.map((h) => new Date(h.project.updated_at).getTime()).filter((t) => !Number.isNaN(t));
  const last = updated.length ? new Date(Math.max(...updated)).toISOString().slice(0, 10) : null;
  const head = en ? "From the project notes (written offers, not unit records). Check before quoting:" : "من ملاحظات المشاريع (عروض مكتوبة، مش وحدات مسجلة). اتأكد قبل ما تقتبس السعر:";
  const foot = last ? (en ? `Last updated: ${last}` : `آخر تحديث: ${last}`) : en ? "Last updated: not recorded" : "آخر تحديث: غير مسجل";
  const more = total > hits.length ? (en ? `…and ${total - hits.length} more. Narrow the request (size, budget or place) to see them.` : `…و${total - hits.length} عروض تانية. ضيّق الطلب (مساحة أو ميزانية أو مكان) عشان تشوفها.`) : null;
  const count = en ? `${total} offers` : `${total} عرض`;
  return [head, count, "", ...lines, ...(more ? [more] : []), "", foot].join("\n");
}

/**
 * Text a broker can forward to a client: only project, size, price, down payment and installment. No raw note lines,
 * no commission, no internal remarks.
 */
function clientText(hits, lang = "ar") {
  const en = lang === "en";
  const money = (n) => Number(n).toLocaleString("en-US");
  const lines = hits.map(({ project, unit: u }) => {
    const bits = [
      u.area != null ? `${u.area} ${en ? "m²" : "م²"}` : null,
      `${money(u.price)} ${en ? "EGP" : "جنيه"}`,
      u.down != null ? (en ? `down payment ${money(u.down)}` : `مقدم ${money(u.down)}`) : null,
      u.monthly != null || u.monthly_est != null ? (en ? `about ${money(u.monthly ?? u.monthly_est)}/month` : `قسط حوالي ${money(u.monthly ?? u.monthly_est)} شهريًا`) : null
    ].filter(Boolean);
    return `• ${project.name_en || project.name}: ${bits.join(" · ")}`;
  });
  return lines.join("\n");
}

/**
 * The offers in the notes of every active project of the agency that fit the filters, cheapest first. One query, no per-project limit,
 * so it stays correct for 100+ projects. Returns { total, hits, scanned }.
 */
async function offersFor(pool, agencyId, filters = {}, { limit = 15 } = {}) {
  const projects = await Offers.projectsWithOffers(pool, agencyId);
  const hits = ProjectNotes.matchUnits(projects, filters);
  return { total: hits.length, hits: hits.slice(0, limit), scanned: projects.length };
}

/**
 * Ask's result list: the offers that fit, grouped by project (every project once, its fitting offers inside), paged.
 * sort: "best" (most fitting offers first) | "cheap" / "pricey" (price, low or high first) | "small" / "big" (area, small or large first). → { projects, total_projects, total_offers, page, pages }
 */
async function projectResults(pool, agencyId, filters = {}, { page = 1, perPage = 10, sort = "best" } = {}) {
  const { hits } = await offersFor(pool, agencyId, filters, { limit: 100000 });
  const byProject = new Map();
  for (const h of hits) {
    const key = h.project.name;
    if (!byProject.has(key)) byProject.set(key, { project: h.project, offers: [] });
    byProject.get(key).offers.push(h.unit);
  }
  const groups = [...byProject.values()];
  const area = (o) => (o.area == null ? 0 : o.area);
  const order = {
    cheap: [(a, b) => a.price - b.price, (a, b) => a.offers[0].price - b.offers[0].price],
    pricey: [(a, b) => b.price - a.price, (a, b) => b.offers[0].price - a.offers[0].price],
    small: [(a, b) => area(a) - area(b), (a, b) => area(a.offers[0]) - area(b.offers[0])],
    big: [(a, b) => area(b) - area(a), (a, b) => area(b.offers[0]) - area(a.offers[0])]
  }[sort];
  for (const g of groups) g.offers.sort(order ? order[0] : (a, b) => a.price - b.price);
  groups.sort(order ? order[1] : (a, b) => b.offers.length - a.offers.length || a.offers[0].price - b.offers[0].price);
  const pages = Math.max(1, Math.ceil(groups.length / perPage));
  const at = Math.min(Math.max(1, Number(page) || 1), pages);
  return { projects: groups.slice((at - 1) * perPage, at * perPage), total_projects: groups.length, total_offers: hits.length, page: at, pages };
}

module.exports = { __sizesNotRecorded: sizesNotRecorded, projectResults, offersFor, clientText, answer, nameWords, requestNumbers, matchProjects, noteLines, projectReply, notesReply };
