// services/aiUsageLog.js — The agency's AI use, line by line (F24): every AI call that counts against the plan's text
// or voice allowance (operation_logs, the same rows services/billing.js counts) and every document page read
// (price_read_log; pages read before by any agency are free). Filterable by Cairo month, user and feature; managers
// see their agency on /app/usage/log, the owner any agency; both export to Excel.
"use strict";

const ExcelJS = require("exceljs");

const FEATURES = {
  search_parse: ["بحث", "Search"],
  listing_extraction: ["إضافة وحدة", "Add a unit"],
  vision_curation: ["ترتيب الصور", "Photo sorting"],
  audio_transcription: ["فويس", "Voice note"],
  lead_extraction: ["عميل جديد", "New lead"],
  lead_update: ["تحديث عميل", "Lead update"],
  follow_up_draft: ["رسالة متابعة", "Follow-up draft"],
  catalogue_update: ["تحديث الكتالوج", "Catalogue update"],
  price_list_read: ["قراءة قائمة أسعار", "Price list reading"],
  brochure_read: ["قراءة بروشور", "Brochure reading"],
  brochure_highlights: ["مميزات المشروع", "Project highlights"],
  plans_read: ["قراءة أنظمة سداد", "Payment plans reading"],
  assistant: ["المساعد", "Assistant"],
  page_read: ["صفحة ملف", "Document page"]
};
const featureLabel = (f, lang) => (FEATURES[f] || [f, f])[lang === "en" ? 1 : 0];
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const UUID_RE = /^[0-9a-f-]{36}$/i;
const MAX_ROWS = 5000;

/** "2026-10" in Cairo time. */
const monthOf = (now = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit" }).format(now).slice(0, 7);

/**
 * The log for one agency and Cairo month: { month, rows: [{ at, broker_id, broker, feature, kind, free }], totals, brokers, features }.
 * kind: text | voice | page. free: a page another read already paid for.
 */
async function list(db, agencyId, { month = null, brokerId = null, feature = null, now = new Date() } = {}) {
  const m = MONTH_RE.test(String(month || "")) ? month : monthOf(now);
  const range = `(($2 || '-01')::timestamp AT TIME ZONE 'Africa/Cairo')`;
  const next = `((($2 || '-01')::timestamp + INTERVAL '1 month') AT TIME ZONE 'Africa/Cairo')`;
  const { rows: all } = await db.query(
    `SELECT * FROM (
       SELECT o.created_at AS at, o.broker_id, o.operation_type AS feature,
              CASE WHEN o.metadata->>'media' = 'audio' THEN 'voice' ELSE 'text' END AS kind, false AS free
         FROM operation_logs o
        WHERE o.agency_id = $1 AND o.status = 'success' AND o.model_used IS NOT NULL AND o.created_at >= ${range} AND o.created_at < ${next}
       UNION ALL
       SELECT l.created_at, l.broker_id, 'page_read', 'page', l.reused
         FROM price_read_log l
        WHERE l.agency_id = $1 AND l.created_at >= ${range} AND l.created_at < ${next}
     ) u ORDER BY at DESC`,
    [agencyId, m]
  );
  const { rows: people } = await db.query("SELECT id, name FROM brokers WHERE agency_id = $1", [agencyId]);
  const names = new Map(people.map((p) => [p.id, p.name]));
  const totals = { text: 0, voice: 0, page: 0, free: 0 };
  const brokers = new Map();
  const features = new Set();
  const rows = [];
  for (const r of all) {
    if (r.broker_id) brokers.set(r.broker_id, names.get(r.broker_id) || "—");
    features.add(r.feature);
    if (brokerId && r.broker_id !== brokerId) continue;
    if (feature && r.feature !== feature) continue;
    if (r.free) totals.free++;
    else totals[r.kind]++;
    if (rows.length < MAX_ROWS) rows.push({ ...r, broker: r.broker_id ? names.get(r.broker_id) || "—" : "—" });
  }
  return { month: m, rows, totals, truncated: rows.length < all.length && rows.length === MAX_ROWS, brokers: [...brokers].map(([id, name]) => ({ id, name })), features: [...features].sort() };
}

/** Parses the page's filters (anything unknown is ignored). */
function filtersOf(q = {}) {
  return {
    month: MONTH_RE.test(String(q.month || "")) ? q.month : null,
    brokerId: UUID_RE.test(String(q.broker || "")) ? q.broker : null,
    feature: /^[a-z_]{1,40}$/.test(String(q.feature || "")) ? q.feature : null
  };
}

const cairoTime = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(d)).replace(",", "");

/** The log as an .xlsx buffer. */
async function workbook(log, lang = "ar") {
  const en = lang === "en";
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(en ? "AI usage" : "استهلاك الذكاء الاصطناعي", { views: [{ rightToLeft: !en }] });
  ws.columns = [
    { header: en ? "Date and time (Cairo)" : "التاريخ والوقت (القاهرة)", key: "at", width: 20 },
    { header: en ? "User" : "المستخدم", key: "broker", width: 22 },
    { header: en ? "Feature" : "الخاصية", key: "feature", width: 24 },
    { header: en ? "Counted as" : "اتحسب من", key: "kind", width: 14 },
    { header: en ? "Free (read before)" : "ببلاش (اتقرت قبل كده)", key: "free", width: 18 }
  ];
  const KIND = { text: ["نص", "Text"], voice: ["فويس", "Voice"], page: ["صفحة", "Page"] };
  for (const r of log.rows) ws.addRow({ at: cairoTime(r.at), broker: r.broker, feature: featureLabel(r.feature, lang), kind: KIND[r.kind][en ? 1 : 0], free: r.free ? (en ? "Yes" : "أيوه") : "" });
  ws.getRow(1).font = { bold: true };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { FEATURES, featureLabel, monthOf, list, filtersOf, cairoTime, workbook };
