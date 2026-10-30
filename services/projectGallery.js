// services/projectGallery.js — A project's photo gallery (F23). Managers upload photos or a PDF; each file is kept in
// storage. With document reading on (the owner's switch, the same monthly pages and shared cache as price lists), AI
// sorts every image or page into shared (renders, amenities, master plan), a layout (type, area, bedrooms, label,
// attached to the matching units) or hidden; unsure layouts wait in a short list for the manager. With reading off
// every photo is shared and the manager sorts by hand. Readers: sharedFor (client page, flyer) and layoutsFor (a unit).
"use strict";

const crypto = require("crypto");
const G = require("../domain/gallery");
const PriceReading = require("./priceReading");
const Storage = require("../lib/supabase");
const { isManager } = require("../lib/authz");

const UUID_RE = /^[0-9a-f-]{36}$/i;
const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf" };

async function projectOf(db, actor, projectId) {
  if (!UUID_RE.test(String(projectId || ""))) return null;
  const { rows } = await db.query("SELECT * FROM projects WHERE id = $1 AND agency_id = $2", [projectId, actor.agency_id]);
  return rows[0] || null;
}

const projectUnits = async (db, projectId) =>
  (await db.query("SELECT id, code, property_type, bedrooms, area_value, details, status FROM listings WHERE project_id = $1 AND status <> 'deleted' ORDER BY code", [projectId])).rows;

async function store(actor, project, data, mime) {
  const path = `${actor.agency_id}/projects/${project.id}/gallery/${crypto.randomBytes(12).toString("hex")}.${EXT[mime]}`;
  const url = await Storage.uploadProjectFile(actor.agency_id, path, data, mime);
  return url ? { url, path } : null;
}

/**
 * Uploads photos or one PDF (pages picked) into the gallery, sorted by AI when reading is on.
 * @returns {Promise<{ ok, added, shared, layouts, matched, unsure, hidden, ai } | { error, left?, needed? }>}
 */
async function upload(pool, actor, projectId, { files = [], pages = "" } = {}, { now = new Date() } = {}) {
  if (!isManager(actor)) return { error: "forbidden" };
  const project = await projectOf(pool, actor, projectId);
  if (!project) return { error: "not_found" };
  if (!files.length) return { error: "NO_FILE" };
  const ai = (await PriceReading.settingOf(pool, actor.agency_id)).enabled;
  if (!ai && files.some((f) => f.mimetype === "application/pdf")) return { error: "OFF" }; // a PDF needs AI to know what each page is
  const got = await PriceReading.pagesOf(files, pages, { version: G.VERSION, maxPages: G.MAX_FILES });
  if (got.error) return got;
  let results = new Map();
  let failed = [];
  if (ai) {
    const r = await PriceReading.readPages(pool, actor, project.id, got.list, { prompt: G.PROMPT, parse: G.classify, operationType: "gallery_read", now });
    if (r.error) return r;
    results = r.results;
    failed = r.failed;
  }
  const units = await projectUnits(pool, project.id);
  const { rows: last } = await pool.query("SELECT coalesce(max(position), -1) AS n FROM project_images WHERE project_id = $1", [project.id]);
  let position = last[0].n + 1;
  const out = { ok: true, added: 0, shared: 0, layouts: 0, matched: 0, unsure: 0, hidden: 0, ai, failed };
  for (const p of got.list) {
    const c = results.get(p.fingerprint) || { kind: ai ? "other" : "render", layout: {} };
    const role = ai && failed.includes(p.label) ? "shared" : G.roleOf(c.kind);
    const saved = await store(actor, project, p.data, p.mime);
    if (!saved) continue;
    const match = role === "layout" ? G.matchUnits(c.layout, units) : null;
    await pool.query(
      `INSERT INTO project_images (agency_id, project_id, url, storage_path, mime, role, kind, layout, match_status, listing_ids, position)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::uuid[], $11)`,
      [actor.agency_id, project.id, saved.url, saved.path, p.mime, role, c.kind, JSON.stringify(c.layout || {}), match?.status || null, match?.ids || [], position++]
    );
    out.added++;
    if (role === "shared") out.shared++;
    if (role === "hidden") out.hidden++;
    if (role === "layout") {
      out.layouts++;
      out[match.status === "matched" ? "matched" : "unsure"]++;
    }
  }
  return out;
}

async function list(db, actor, projectId) {
  const project = await projectOf(db, actor, projectId);
  if (!project) return null;
  const { rows } = await db.query("SELECT * FROM project_images WHERE project_id = $1 ORDER BY position", [project.id]);
  return { project, images: rows, units: isManager(actor) ? await projectUnits(db, project.id) : [] };
}

async function imageOf(db, actor, projectId, imageId) {
  if (!UUID_RE.test(String(imageId || ""))) return null;
  const project = await projectOf(db, actor, projectId);
  if (!project) return null;
  const { rows } = await db.query("SELECT * FROM project_images WHERE id = $1 AND project_id = $2", [imageId, project.id]);
  return rows[0] ? { project, image: rows[0] } : null;
}

/** The manager's change: role (shared | layout | hidden) and, for a layout, the units it belongs to. */
async function update(db, actor, projectId, imageId, { role, listingIds } = {}) {
  if (!isManager(actor)) return { error: "forbidden" };
  const got = await imageOf(db, actor, projectId, imageId);
  if (!got) return { error: "not_found" };
  const r = ["shared", "layout", "hidden"].includes(role) ? role : got.image.role;
  let ids = [];
  if (r === "layout") {
    const allowed = new Set((await projectUnits(db, got.project.id)).map((u) => u.id));
    ids = [].concat(listingIds ?? got.image.listing_ids ?? []).filter((id) => allowed.has(id));
  }
  const status = r !== "layout" ? null : listingIds !== undefined ? (ids.length ? "manual" : "unsure") : got.image.match_status || "unsure";
  const { rows } = await db.query("UPDATE project_images SET role = $3, listing_ids = $4::uuid[], match_status = $5 WHERE id = $1 AND project_id = $2 RETURNING *", [imageId, got.project.id, r, ids, status]);
  return { ok: true, image: rows[0] };
}

async function remove(db, actor, projectId, imageId) {
  if (!isManager(actor)) return { error: "forbidden" };
  const got = await imageOf(db, actor, projectId, imageId);
  if (!got) return { error: "not_found" };
  await db.query("DELETE FROM project_images WHERE id = $1", [imageId]);
  if (got.image.storage_path) await Storage.deleteStorageFiles([got.image.storage_path]);
  return { ok: true };
}

/** The project's shared photos for a unit's client page and flyer (images only, in order). */
async function sharedFor(db, listing, { limit = 10 } = {}) {
  if (!listing?.project_id) return [];
  const { rows } = await db.query(
    "SELECT url FROM project_images WHERE project_id = $1 AND agency_id = $2 AND role = 'shared' AND mime LIKE 'image/%' ORDER BY position LIMIT $3",
    [listing.project_id, listing.agency_id, limit]
  );
  return rows;
}

/** The layouts attached to a unit: [{ url, mime, layout }]. */
async function layoutsFor(db, listing) {
  if (!listing?.project_id) return [];
  const { rows } = await db.query(
    "SELECT url, mime, layout FROM project_images WHERE project_id = $1 AND agency_id = $2 AND role = 'layout' AND $3 = ANY(listing_ids) ORDER BY position",
    [listing.project_id, listing.agency_id, listing.id]
  );
  return rows;
}

module.exports = { upload, list, update, remove, sharedFor, layoutsFor };
