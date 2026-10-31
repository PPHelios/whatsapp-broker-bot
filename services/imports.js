// services/imports.js — Excel diff import and group import (forwarded posts / chat export). Returns data.
// A plan is computed, stored in web_imports and shown; applying it re-checks every row under the same
// locks and rules as WhatsApp: createListing (insert-only) and applyListingPatch (optimistic lock).
"use strict";

const L = require("../lib/listing");
const Store = require("../lib/listingStore");
const Edits = require("../lib/edits");
const Authz = require("../lib/authz");
const U = require("../lib/util");
const Rules = require("../domain/fieldRules");
const Describe = require("../domain/describe");
const Features = require("../domain/features");
const Delivery = require("../domain/delivery");
const SheetImport = require("../domain/sheetImport");
const Dup = require("../domain/unitDuplicate");
const { normalizeCode } = require("../domain/searchQuery");
const { normalizeSearch } = require("../domain/searchText");
const Supabase = require("../lib/supabase");
const PhotoHash = require("./photoHash");
const Vis = require("../lib/visibility");

const MONEY = ["price_value", "down_payment_value", "remaining_amount", "installment_value"];
const DETAIL_LABELS = { owner_name: ["المالك", "Owner"], owner_phone: ["تليفون المالك", "Owner phone"], notes: ["ملاحظات", "Notes"], clean_summary: ["الوصف", "Description"], summary_en: ["الوصف بالإنجليزي", "English summary"], floor: ["الدور", "Floor"] };
const STATUS = { active: ["متاحة", "Available"], sold: ["مباعة", "Sold"], archived: ["مؤرشفة", "Archived"] };
const pick = (pair, lang) => (pair ? pair[lang === "en" ? 1 : 0] : null);

function display(col, v, lang) {
  if (v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length)) return "—";
  if (MONEY.includes(col)) return Describe.money(v, lang) || String(v);
  if (col === "feature_keys") return v.map((k) => Features.featureLabel(k, lang)).join("، ");
  if (col === "finishing") return pick(Describe.FINISHING_LABELS[v], lang) || v;
  if (col === "status") return pick(STATUS[v], lang) || v;
  if (col === "property_type") return pick(Describe.TYPE_LABELS[v], lang) || v;
  if (col === "installments_end") return String(v instanceof Date ? v.toISOString() : v).slice(0, 7);
  if (Array.isArray(v)) return v.join("، ");
  return String(v);
}

const DELIVERY_COLS = ["delivery_year", "delivery_quarter", "delivery_month", "is_ready", "delivery_raw"];
const HIDDEN_COLS = ["payment_terms", "inventory_type", "location_keywords", "price_display"];

/** Human list of what a patch changes: [{ field, label, from, to }]. */
function describeChanges(listing, patch, lang = "ar") {
  const out = [];
  for (const [col, to] of Object.entries(patch)) {
    if (HIDDEN_COLS.includes(col) || DELIVERY_COLS.includes(col)) continue;
    if (col === "details") {
      for (const k of Object.keys(DETAIL_LABELS)) {
        const a = listing.details?.[k] ?? null;
        const b = to?.[k] ?? null;
        if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ field: `details.${k}`, label: pick(DETAIL_LABELS[k], lang), from: display(k, a, lang), to: display(k, b, lang) });
      }
      continue;
    }
    const label = col === "status" ? pick(["الحالة", "Status"], lang) : pick(Edits.FIELD_LABELS[col], lang) || col;
    out.push({ field: col, label, from: display(col, listing[col], lang), to: display(col, to, lang) });
  }
  if (DELIVERY_COLS.some((c) => c in patch)) {
    const show = (l) => Delivery.formatDelivery(l, lang, { icon: false }) || "—";
    out.push({ field: "delivery", label: pick(["التسليم", "Delivery"], lang), from: show(listing), to: show({ ...listing, ...patch }) });
  }
  return out;
}

const same = (a, b) => Boolean(a) && Boolean(b) && normalizeSearch(a) === normalizeSearch(b);

/**
 * The agency export (lib/excel.js) writes the English compound and title when known and the raw text as
 * the description; such a value is the unit's own, not a change.
 */
function dropEchoes(existing, draft) {
  const d = existing.details || {};
  if (draft.compound && [existing.compound, existing.compound_en, d.compound_en].some((v) => same(v, draft.compound))) delete draft.compound;
  if (draft.title && [existing.title, d.title_en].some((v) => same(v, draft.title))) delete draft.title;
  if (draft.details?.clean_summary && [d.clean_summary, existing.raw_text].some((v) => same(v, draft.details.clean_summary))) delete draft.details.clean_summary;
  if (draft.details?.summary_en && same(d.summary_en, draft.details.summary_en)) delete draft.details.summary_en;
  if (draft.district && [existing.district, existing.city, existing.location].some((v) => same(v, draft.district))) delete draft.district;
  return draft;
}

/** A sheet row states the features column exactly (no union with the stored keys). */
function composeRow(existing, draft, lang) {
  const composed = L.composeFields({ existing, draft, lang });
  if ("feature_keys" in draft) {
    composed.feature_keys = Features.sortKeys(draft.feature_keys);
    composed.features_other = draft.features_other || [];
  }
  return composed;
}

const reasonOf = (b, lang) => (lang === "en" ? b.label_en : b.label_ar);
const ERROR_LABELS = { code: ["كود غير صالح", "Invalid code"], property_type: ["نوع غير معروف", "Unknown type"], price_value: ["سعر غير صحيح", "Invalid price"], area_value: ["مساحة غير صحيحة", "Invalid area"] };

/**
 * Plans an Excel import against the agency's inventory (nothing is written).
 * @param {Object} sheet - lib/sheets.js readInventorySheet output
 * @returns {Promise<{ items, counts }>}
 */
async function planExcel(pool, broker, sheet, { lang = "ar" } = {}) {
  const parsed = sheet.rows.map((r) => ({ rowNumber: r.rowNumber, ...SheetImport.rowToDraft(r.cells) }));
  const codes = [...new Set(parsed.map((p) => normalizeCode(p.code)).filter(Boolean))];
  const { rows: found } = await pool.query("SELECT * FROM listings WHERE " + Vis.units("listings") + " AND agency_id = $1 AND code_norm = ANY($2::text[])", [broker.agency_id, codes]);
  const byCode = new Map(found.map((l) => [l.code_norm, l]));
  const seen = new Set();
  const items = [];

  for (const p of parsed) {
    const code = normalizeCode(p.code);
    const base = { row: p.rowNumber, code: code || null };
    if (p.errors.length) {
      items.push({ ...base, kind: "invalid", reasons: p.errors.map((e) => pick(ERROR_LABELS[e], lang) || e) });
      continue;
    }
    if (code && seen.has(code)) {
      items.push({ ...base, kind: "invalid", reasons: [lang === "en" ? "Code repeated in the sheet" : "الكود مكرر في الشيت"] });
      continue;
    }
    if (code) seen.add(code);
    const existing = code ? byCode.get(code) : null;
    if (existing) {
      if (!Authz.canEdit(broker, existing)) {
        items.push({ ...base, code: existing.code, kind: "forbidden", reasons: [lang === "en" ? "Another broker's unit" : "وحدة وسيط تاني"] });
        continue;
      }
      const ev = Rules.evaluate(composeRow(existing, dropEchoes(existing, p.draft), lang), { lang });
      if (!ev.ok) {
        items.push({ ...base, code: existing.code, kind: "invalid", reasons: ev.blockers.map((b) => reasonOf(b, lang)) });
        continue;
      }
      const patch = Edits.diffPatch(existing, ev.listing);
      if (p.status && p.status !== existing.status) patch.status = p.status;
      const changes = describeChanges(existing, patch, lang);
      items.push({
        ...base,
        code: existing.code,
        // Only what the broker can see counts; normalization the row did not ask for (e.g. a villa's
        // stored BUA) is not a change.
        kind: changes.length ? "changed" : "unchanged",
        listing_id: existing.id,
        version: existing.version,
        patch,
        changes
      });
    } else {
      const ev = Rules.evaluate(composeRow(null, p.draft, lang), { lang });
      if (!ev.ok) {
        items.push({ ...base, kind: "invalid", reasons: ev.blockers.map((b) => reasonOf(b, lang)) });
        continue;
      }
      if (p.status && p.status !== "active") ev.listing.status = p.status;
      items.push({ ...base, kind: "new", fields: ev.listing, warnings: ev.warnings.map((w) => Rules.warningLine(w, lang)) });
    }
  }

  const counts = items.reduce((acc, i) => ({ ...acc, [i.kind]: (acc[i.kind] || 0) + 1 }), {});
  return { items, counts };
}

/** Saves a plan; returns its id. */
async function savePlan(pool, broker, kind, payload, { filename = null, status = "ready" } = {}) {
  const { rows } = await pool.query(
    "INSERT INTO web_imports (agency_id, broker_id, kind, status, filename, payload) VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING id",
    [broker.agency_id, broker.id, kind, status, filename, JSON.stringify(payload)]
  );
  return rows[0].id;
}

async function loadImport(pool, broker, id) {
  if (!/^[0-9a-f-]{36}$/.test(String(id))) return null;
  const { rows } = await pool.query("SELECT * FROM web_imports WHERE id = $1 AND agency_id = $2 AND broker_id = $3", [id, broker.agency_id, broker.id]);
  return rows[0] || null;
}

/** Claims a ready plan once (a second apply, a stale tab or an expired plan gets null). */
async function claim(pool, broker, id, kind) {
  const { rows } = await pool.query(
    `UPDATE web_imports SET status = 'applied', applied_at = NOW()
     WHERE id = $1 AND agency_id = $2 AND broker_id = $3 AND kind = $4 AND status = 'ready' AND expires_at > NOW()
     RETURNING *`,
    [id, broker.agency_id, broker.id, kind]
  );
  return rows[0] || null;
}

async function insertOne(pool, broker, fields, code, lang) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const res = await Store.createListing(client, broker, { fields, code, lang });
    if (res.listing && fields.status && fields.status !== "active") {
      await client.query("UPDATE listings SET status = $1 WHERE id = $2 AND agency_id = $3", [fields.status, res.listing.id, broker.agency_id]);
    }
    await client.query(res.listing ? "COMMIT" : "ROLLBACK");
    return res;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** One patch with the version seen at planning time. */
async function patchOne(pool, broker, code, patch, expectedVersion) {
  return Edits.withCodeLock(pool, broker.agency_id, code, async (client) => {
    const listing = await Store.findByCode(client, broker.agency_id, code, { forUpdate: true });
    if (!listing) return { rollback: true, outcome: "missing" };
    if (!Authz.canEdit(broker, listing)) return { rollback: true, outcome: "forbidden" };
    const res = await Store.applyListingPatch(client, broker, { listing, patch, expectedVersion: expectedVersion ?? listing.version });
    if (res.conflict) return { rollback: true, outcome: "conflict" };
    return { outcome: "updated", listing: res.listing };
  });
}

/**
 * Applies the selected rows of an Excel plan. Each row is its own transaction.
 * @returns {Promise<{ created, updated, conflicts, failed } | null>} null when the plan cannot be applied
 */
async function applyExcel(pool, broker, id, { rows = [], lang = "ar" } = {}) {
  const imp = await claim(pool, broker, id, "excel");
  if (!imp) return null;
  const wanted = new Set(rows.map(Number));
  const result = { created: [], updated: [], conflicts: [], failed: [] };
  for (const item of imp.payload.items) {
    if (!wanted.has(item.row)) continue;
    if (item.kind === "new") {
      const res = await insertOne(pool, broker, item.fields, item.code, lang);
      if (res.listing) result.created.push(res.listing.code);
      else if (res.limit) {
        result.limit = res.limit;
        break;
      } else result.conflicts.push(res.code);
    } else if (item.kind === "changed") {
      const res = await patchOne(pool, broker, item.code, item.patch, item.version);
      if (res.outcome === "updated") result.updated.push(item.code);
      else (res.outcome === "conflict" ? result.conflicts : result.failed).push(item.code);
    }
  }
  await pool.query("UPDATE web_imports SET result = $2::jsonb WHERE id = $1", [id, JSON.stringify(result)]);
  return result;
}

const MAX_CELL = 600;

/**
 * Edits one row of a ready Excel plan and plans the whole sheet again from the edited cells, so the row goes through
 * the same parsing and rules as an upload. Only the sheet's own columns can be edited.
 * @param {Object} cells - field key → new text
 * @returns {Promise<boolean>} false when the plan is not ready, expired, has no stored sheet or the row is unknown
 */
async function editExcelRow(pool, broker, id, rowNumber, cells, { lang = "ar" } = {}) {
  const imp = await loadImport(pool, broker, id);
  if (!imp || imp.kind !== "excel" || imp.status !== "ready" || new Date(imp.expires_at) <= new Date()) return false;
  const { rows, columns } = imp.payload;
  const target = Array.isArray(rows) ? rows.find((r) => r.rowNumber === Number(rowNumber)) : null;
  if (!target) return false;
  for (const key of columns || []) if (key in cells) target.cells[key] = String(cells[key] ?? "").slice(0, MAX_CELL).trim();
  const plan = await planExcel(pool, broker, { rows }, { lang });
  await pool.query("UPDATE web_imports SET payload = $2::jsonb WHERE id = $1 AND status = 'ready'", [id, JSON.stringify({ ...plan, rows, columns })]);
  return true;
}

/* ---------------------------------------------------------------------- */
/* Group import: forwarded posts and chat exports                           */
/* ---------------------------------------------------------------------- */

const jobs = new Map(); // import id → promise (tests and graceful shutdown can wait for it)

/** An active unit that looks like this one (the shared P13 rule). */
const findDuplicate = (pool, agencyId, l) => Store.findDuplicate(pool, agencyId, l);

/**
 * Extracts every post with the WhatsApp listing extraction (two at a time) and stores the results
 * progressively in the import's payload; status becomes ready (or failed).
 */
async function processGroup(pool, broker, id, { AI, ctx, lang = "ar" }) {
  const imp = await loadImport(pool, broker, id);
  const posts = imp.payload.posts || [];
  const results = new Array(posts.length).fill(null);
  const limit = U.createLimiter(2);
  let stopped = null;
  const save = (status = "processing") =>
    pool.query("UPDATE web_imports SET payload = jsonb_set(payload, '{results}', $2::jsonb), status = $3 WHERE id = $1", [id, JSON.stringify(results), status]);

  await Promise.all(
    posts.map((post, i) =>
      limit(async () => {
        if (stopped) {
          results[i] = { i, error: stopped };
          return;
        }
        try {
          const ex = await L.extractPropertyDetails(AI, { texts: [post.text], lang, ctx });
          const composed = L.composeFields({ draft: ex.fields, lang });
          composed.details = { ...composed.details, source: "group_import", ...(post.sender ? { co_broker: post.sender } : {}), ...(ex.fields.code ? { source_ref: ex.fields.code } : {}) };
          const ev = Rules.evaluate(composed, { lang });
          results[i] = {
            i,
            ok: ev.ok,
            fields: ev.listing,
            blockers: ev.blockers.map((b) => reasonOf(b, lang)),
            warnings: ev.warnings.map((w) => Rules.warningLine(w, lang)),
            duplicate: ev.ok ? await findDuplicate(pool, broker.agency_id, ev.listing) : null
          };
        } catch (err) {
          if (err.code && /QUOTA/.test(err.code)) stopped = "quota";
          results[i] = { i, error: stopped || "ai" };
        }
        await save().catch(() => {});
      })
    )
  );
  // Posts inside one paste that describe the same unit (the same rule): the later one points at the first.
  results.forEach((r, i) => {
    if (!r?.ok || r.duplicate) return;
    const j = results.findIndex((o, k) => k < i && o?.ok && o.same_as === undefined && Dup.sameUnit(r.fields, o.fields));
    if (j >= 0) r.same_as = j;
  });
  await save("ready");
}

/**
 * Saves the posts and starts extracting them in the background. Returns the import id.
 * Posts may carry photos [{ url, hash }]; the match page adds them one by one after the import starts.
 */
async function startGroupImport(pool, broker, posts, { AI, ctx, lang = "ar", filename = null }) {
  const id = await savePlan(pool, broker, "group", { posts, results: [] }, { filename, status: "processing" });
  const job = new Promise((resolve) => setImmediate(resolve))
    .then(async () => {
      await processGroup(pool, broker, id, { AI, ctx, lang });
    })
    .catch(async (err) => {
      console.error("Group import failed:", err.message);
      await pool.query("UPDATE web_imports SET status = 'failed' WHERE id = $1", [id]).catch(() => {});
    })
    .finally(() => {
      jobs.delete(id);
    });
  jobs.set(id, job);
  return id;
}

/** Resolves when a running group import finishes (immediately if none). */
function waitForGroupImport(id) {
  return jobs.get(id) || Promise.resolve();
}

/** Creates the selected, complete posts as new units (generated codes; the poster stays internal). */
async function applyGroup(pool, broker, id, { rows = [], lang = "ar" } = {}) {
  const imp = await claim(pool, broker, id, "group");
  if (!imp) return null;
  const wanted = new Set(rows.map(Number));
  const result = { created: [], failed: [] };
  const posts = imp.payload.posts || [];
  const used = new Set();
  for (const r of imp.payload.results || []) {
    if (!r || !wanted.has(r.i) || !r.ok) continue;
    const res = await insertOne(pool, broker, r.fields, null, lang);
    if (!res.listing) {
      result.failed.push(r.i);
      if (res.limit) result.limit = res.limit;
      continue;
    }
    result.created.push(res.listing.code);
    // Photos from a chat export zip go on the new unit, with their hashes for the duplicate-photo flag.
    const photos = (posts[r.i]?.photos || []).filter((p) => p.url);
    if (photos.length) {
      await Store.addPhotos(pool, res.listing, photos.map((p) => p.url));
      await PhotoHash.saveHashes(pool, broker.agency_id, new Map(photos.map((p) => [p.url, p.hash])));
      photos.forEach((p) => used.add(p.url));
    }
  }
  const unused = posts.flatMap((p) => (p.photos || []).map((x) => x.url)).filter((u) => u && !used.has(u));
  if (unused.length) await Supabase.deleteStorageFiles(unused);
  await pool.query("UPDATE web_imports SET result = $2::jsonb WHERE id = $1", [id, JSON.stringify(result)]);
  return result;
}

module.exports = {
  describeChanges,
  planExcel,
  savePlan,
  loadImport,
  applyExcel,
  editExcelRow,
  findDuplicate,
  startGroupImport,
  waitForGroupImport,
  applyGroup
};
