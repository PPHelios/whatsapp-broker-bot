// services/placeReview.js — The owner's review of new places. New compound names (place_names) and new areas or sub-zones
// (areas, status pending) wait here; the owner approves one as a new place, merges it into an existing one as an alias, or
// rejects it with a reason, and the brokers who proposed it are told. Pending items are never shown to brokers.
"use strict";

const { withTransaction } = require("../lib/db");
const P = require("../domain/mapPlaces");
const A = require("../domain/areas");
const R = require("../domain/placeReview");
const Areas = require("./areas");
const MapPlaces = require("./mapPlaces");

// A broker can queue this many new names or areas per hour (an import counts as one batch). More are not queued; the unit is still saved.
const PER_HOUR = 5;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clip = (v, n) => String(v ?? "").trim().slice(0, n) || null;
const ids = (list) => [...new Set([].concat(list || []).filter((x) => UUID.test(String(x))))];

/** True when this broker has already queued PER_HOUR new items in the last hour. */
async function overLimit(db, brokerId) {
  if (!brokerId) return false;
  const { rows } = await db.query(
    `SELECT count(DISTINCT coalesce(batch, kind || ref_id::text))::int AS n FROM place_proposals
      WHERE broker_id = $1 AND created_at >= now() - interval '1 hour'`,
    [brokerId]
  );
  return rows[0].n >= PER_HOUR;
}

/** Remembers who proposed an item (for the hourly limit and the rejection notice). */
async function recordProposal(db, kind, refId, brokerId, batch = null) {
  if (!brokerId) return;
  await db.query(
    `INSERT INTO place_proposals (kind, ref_id, broker_id, batch)
     SELECT $1, $2, $3, $4 WHERE NOT EXISTS (SELECT 1 FROM place_proposals WHERE kind = $1 AND ref_id = $2 AND broker_id = $3)`,
    [kind, refId, brokerId, batch]
  );
}

/** A broker proposes a new area or sub-zone. Known names are returned as they are; over the hourly limit nothing is queued. */
async function proposeArea(db, brokerId, input, { batch = null } = {}) {
  const c = A.cleanArea(input);
  if (!c.ok) return { status: "invalid", error: c.error };
  const v = c.value;
  const areas = await Areas.approvedAreas(db);
  if (v.parent_id && !areas.some((a) => a.id === v.parent_id)) return { status: "invalid", error: "parent" };
  const known = A.resolveArea(A.buildIndex(areas.filter((a) => (a.parent_id || null) === v.parent_id)), v.name_en || v.name_ar);
  if (known?.id) return { status: "known", id: known.id };
  const found = await db.query("SELECT id, status FROM areas WHERE name_key = $1 AND parent_id IS NOT DISTINCT FROM $2", [v.name_key, v.parent_id]);
  if (found.rows[0]) return { status: found.rows[0].status, id: found.rows[0].id };
  if (await overLimit(db, brokerId)) return { status: "limited" };
  const ins = await db.query(
    `INSERT INTO areas (parent_id, name_key, name_en, name_ar, aliases, lat, lng, status, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', 'broker') RETURNING id`,
    [v.parent_id, v.name_key, v.name_en, v.name_ar, v.aliases, v.lat, v.lng]
  );
  await recordProposal(db, "area", ins.rows[0].id, brokerId, batch);
  return { status: "pending", id: ins.rows[0].id };
}

/** Everything waiting: groups of alike names with the places they may duplicate, plus the lists the owner picks from. */
async function queue(pool) {
  const [names, pendAreas, places, areas] = await Promise.all([
    pool.query("SELECT id, name_en, name_ar, pin_link, times_seen, example, created_at FROM place_names WHERE status = 'pending' ORDER BY times_seen DESC, created_at LIMIT 200"),
    pool.query("SELECT id, parent_id, name_en, name_ar, aliases, created_at FROM areas WHERE status = 'pending' ORDER BY created_at LIMIT 200"),
    pool.query("SELECT id, name_en, name_ar, aliases, area_id, subzone_id FROM map_places WHERE approved"),
    Areas.approvedAreas(pool)
  ]);
  const label = (a) => A.chain(areas, a.id).map((x) => x.name_en || x.name_ar).join(" › ");
  const pathOf = (p) => [p.area_id, p.subzone_id].filter(Boolean).map((i) => areas.find((a) => a.id === i)).filter(Boolean).map((x) => x.name_en || x.name_ar).join(" › ");
  const existing = [
    ...places.rows.map((p) => ({ kind: "compound", id: p.id, name_en: p.name_en, name_ar: p.name_ar, aliases: p.aliases, path: pathOf(p) })),
    ...areas.map((a) => ({ kind: a.parent_id ? "subzone" : "area", id: a.id, name_en: a.name_en, name_ar: a.name_ar, aliases: a.aliases, path: label(a) }))
  ];
  const pending = [
    ...names.rows.map((n) => ({ kind: "compound", id: n.id, name_en: n.name_en, name_ar: n.name_ar, times_seen: n.times_seen, example: n.example })),
    ...pendAreas.rows.map((a) => ({ kind: "area", id: a.id, parent_id: a.parent_id, name_en: a.name_en, name_ar: a.name_ar, aliases: a.aliases, times_seen: 1 }))
  ];
  return {
    groups: R.groupPending(pending, existing),
    topAreas: areas.filter((a) => !a.parent_id).map((a) => ({ id: a.id, name: a.name_en || a.name_ar })),
    subzones: areas.filter((a) => a.parent_id).map((a) => ({ id: a.id, name: label(a) }))
  };
}

/** How many items wait, and how many arrived since `since` (the hourly alert). */
async function counts(db, since) {
  const { rows } = await db.query(
    `SELECT (SELECT count(*) FROM place_names WHERE status = 'pending')::int + (SELECT count(*) FROM areas WHERE status = 'pending')::int AS total,
            (SELECT count(*) FROM place_names WHERE status = 'pending' AND created_at >= $1)::int + (SELECT count(*) FROM areas WHERE status = 'pending' AND created_at >= $1)::int AS fresh`,
    [since]
  );
  return rows[0];
}

/**
 * The owner approves a new compound as a place: needs an area; sub-zone, Arabic name, aliases and a pin are optional.
 * `also` = other pending names in the same group; they become aliases of this place.
 */
async function approveCompound(pool, id, input = {}) {
  const areas = await Areas.approvedAreas(pool);
  const loc = A.checkLocation({ area_id: input.area_id, subzone_id: input.subzone_id }, { kind: "compound", areas });
  if (!loc.ok) return { error: loc.error };
  const name_en = clip(input.name_en, 120);
  const name_ar = clip(input.name_ar, 120);
  if (!name_en && !name_ar) return { error: "name" };
  const lat = input.lat === "" || input.lat == null ? null : Number(input.lat);
  const lng = input.lng === "" || input.lng == null ? null : Number(input.lng);
  if ((lat == null) !== (lng == null) || (lat != null && !(Number.isFinite(lat) && Number.isFinite(lng) && P.inEgypt(lat, lng)))) return { error: "coords" };
  const key = P.placeKey(name_en || name_ar);
  const r = await withTransaction(pool, async (c) => {
    const lead = (await c.query("SELECT id, name_en FROM place_names WHERE id = $1 AND status = 'pending' FOR UPDATE", [id])).rows[0];
    if (!lead) return { error: "not_pending" };
    const others = ids(input.also).filter((x) => x !== id);
    const more = others.length ? (await c.query("SELECT id, name_en FROM place_names WHERE id = ANY($1::uuid[]) AND status = 'pending' FOR UPDATE", [others])).rows : [];
    const aliases = [...new Set([lead.name_en, ...more.map((m) => m.name_en), ...P.parseAliases(input.aliases)].filter((n) => n && P.placeKey(n) !== key))].slice(0, 20);
    const ins = await c.query(
      `INSERT INTO map_places (name_key, name_en, name_ar, developer, district, lat, lng, aliases, verified, source, approved, area_id, subzone_id)
       VALUES ($1, $2, $3, NULL, NULL, $4, $5, $6, false, 'manual', true, $7, $8) ON CONFLICT (name_key) DO NOTHING RETURNING id`,
      [key, name_en, name_ar, lat == null ? null : Math.round(lat * 1e6) / 1e6, lng == null ? null : Math.round(lng * 1e6) / 1e6, aliases, loc.area_id, loc.subzone_id]
    );
    if (!ins.rows[0]) return { error: "duplicate" };
    const placeId = ins.rows[0].id;
    await c.query("UPDATE place_names SET status = 'approved', name_ar = $2, place_id = $3, decided_at = now() WHERE id = $1", [id, name_ar, placeId]);
    if (more.length) await c.query("UPDATE place_names SET status = 'merged', place_id = $2, decided_at = now() WHERE id = ANY($1::uuid[])", [more.map((m) => m.id), placeId]);
    return { ok: true, place_id: placeId, name: name_en || name_ar };
  });
  if (r.ok) await afterChange(pool);
  return r;
}

/** The owner says these pending names are an existing place: they are added to it as aliases and the units that use them are linked. */
async function mergeCompound(pool, id, placeId, { also = [] } = {}) {
  if (!UUID.test(String(placeId || ""))) return { error: "no_place" };
  const place = await MapPlaces.place(pool, placeId);
  if (!place) return { error: "no_place" };
  const picked = ids([id, ...[].concat(also)]);
  const rows = (await pool.query("SELECT id, name_en, name_ar FROM place_names WHERE id = ANY($1::uuid[]) AND status = 'pending'", [picked])).rows;
  if (!rows.some((r) => r.id === id)) return { error: "not_pending" };
  for (const r of rows) {
    for (const n of [r.name_en, r.name_ar]) if (n && P.placeKey(n) !== P.placeKey(place.name_en || place.name_ar)) await MapPlaces.addAlias(pool, placeId, n);
  }
  await pool.query("UPDATE place_names SET status = 'merged', place_id = $2, decided_at = now() WHERE id = ANY($1::uuid[])", [rows.map((r) => r.id), placeId]);
  await afterChange(pool);
  return { ok: true, name: place.name_en || place.name_ar };
}

/** The owner rejects a new name; the brokers who proposed it get a short notice with the reason. */
async function rejectName(pool, id, reason, { also = [] } = {}) {
  const why = clip(reason, 200);
  if (!why) return { error: "reason" };
  const picked = ids([id, ...[].concat(also)]);
  const { rows } = await pool.query(
    "UPDATE place_names SET status = 'rejected', reject_reason = $2, decided_at = now() WHERE id = ANY($1::uuid[]) AND status = 'pending' RETURNING id, name_en",
    [picked, why]
  );
  if (!rows.some((r) => r.id === id)) return { error: "not_pending" };
  for (const r of rows) await notifyProposers(pool, "compound", r.id, r.name_en, why);
  return { ok: true, name: rows.find((r) => r.id === id).name_en };
}

/** The owner approves a new area or sub-zone, with any edits (names, aliases, parent, pin). */
async function approveArea(pool, id, input = {}) {
  const cur = (await pool.query("SELECT id, parent_id, name_en, name_ar, aliases, lat, lng FROM areas WHERE id = $1 AND status = 'pending'", [id])).rows[0];
  if (!cur) return { error: "not_pending" };
  const c = A.cleanArea({ name_en: input.name_en ?? cur.name_en, name_ar: input.name_ar ?? cur.name_ar, aliases: input.aliases ?? cur.aliases, lat: input.lat ?? cur.lat, lng: input.lng ?? cur.lng, parent_id: "parent_id" in input ? input.parent_id || null : cur.parent_id });
  if (!c.ok) return { error: c.error };
  const v = c.value;
  try {
    const { rowCount } = await pool.query(
      "UPDATE areas SET parent_id = $2, name_key = $3, name_en = $4, name_ar = $5, aliases = $6, lat = $7, lng = $8, status = 'approved', updated_at = now() WHERE id = $1 AND status = 'pending'",
      [id, v.parent_id, v.name_key, v.name_en, v.name_ar, v.aliases, v.lat, v.lng]
    );
    if (rowCount) require("./placeSuggest").resetCache();
    return rowCount ? { ok: true, name: v.name_en || v.name_ar } : { error: "not_pending" };
  } catch (e) {
    if (e.code === "23505") return { error: "duplicate" };
    if (/levels|under itself/.test(e.message)) return { error: "bad_parent" };
    throw e;
  }
}

/** A pending area is an existing one: its names become aliases and the compounds and units that used it move over. */
async function mergeArea(pool, id, intoId) {
  if (!UUID.test(String(intoId || "")) || intoId === id) return { error: "no_area" };
  const areas = await Areas.approvedAreas(pool);
  const into = areas.find((a) => a.id === intoId);
  if (!into) return { error: "no_area" };
  const cur = (await pool.query("SELECT id, name_en, name_ar FROM areas WHERE id = $1 AND status = 'pending'", [id])).rows[0];
  if (!cur) return { error: "not_pending" };
  if ((await pool.query("SELECT 1 FROM areas WHERE parent_id = $1 LIMIT 1", [id])).rowCount) return { error: "has_children" };
  const at = A.placement(areas, intoId);
  await withTransaction(pool, async (c) => {
    const names = [cur.name_en, cur.name_ar].filter((n) => n && P.placeKey(n) !== P.placeKey(into.name_en || into.name_ar));
    await c.query("UPDATE areas SET aliases = (SELECT array(SELECT DISTINCT unnest(aliases || $2::text[]))), updated_at = now() WHERE id = $1", [intoId, names]);
    for (const t of ["map_places", "listings"]) {
      await c.query(`UPDATE ${t} SET area_id = $2, subzone_id = $3 WHERE area_id = $1 OR subzone_id = $1`, [id, at.area_id, at.subzone_id]);
    }
    await c.query("DELETE FROM areas WHERE id = $1", [id]);
  });
  require("./placeSuggest").resetCache();
  return { ok: true, name: into.name_en || into.name_ar };
}

/** The owner rejects a new area; compounds and units that pointed at it lose it, and the proposer is told. */
async function rejectArea(pool, id, reason) {
  const why = clip(reason, 200);
  if (!why) return { error: "reason" };
  const r = await withTransaction(pool, async (c) => {
    const { rows } = await c.query("UPDATE areas SET status = 'rejected', reject_reason = $2, updated_at = now() WHERE id = $1 AND status = 'pending' RETURNING name_en, name_ar", [id, why]);
    if (!rows[0]) return null;
    for (const t of ["map_places", "listings"]) await c.query(`UPDATE ${t} SET area_id = NULL, subzone_id = NULL WHERE area_id = $1 OR subzone_id = $1`, [id]);
    return rows[0];
  });
  if (!r) return { error: "not_pending" };
  await notifyProposers(pool, "area", id, r.name_en || r.name_ar, why);
  return { ok: true, name: r.name_en || r.name_ar };
}

/** After a place is approved or merged: the lists search reads are refreshed and flagged units are matched again. */
async function afterChange(pool) {
  MapPlaces.clearCache();
  require("../lib/placeNames").resetCache();
  await MapPlaces.recheck(pool, { apply: true }).catch(() => {});
}

/** Tells each broker who proposed this item that it was rejected, and why (Telegram first, then push or the inbox). */
async function notifyProposers(pool, kind, refId, name, reason) {
  const { rows: who } = await pool.query(
    `SELECT DISTINCT b.id, b.agency_id, b.name, b.role, b.is_active, b.preferred_lang, b.phone_number, b.phone_normalized, b.notify_prefs, b.telegram_chat_id
       FROM place_proposals p JOIN brokers b ON b.id = p.broker_id WHERE p.kind = $1 AND p.ref_id = $2 AND b.is_active`,
    [kind, refId]
  );
  const { notifyBroker } = require("../lib/notifications");
  for (const b of who) {
    const en = b.preferred_lang === "en";
    await notifyBroker(pool, b, {
      kind: "place_review",
      dedupeKey: `place-rejected:${kind}:${refId}`,
      title: en ? `❌ "${name}" was not added to the places list` : `❌ "${name}" ماتضافش لقائمة الأماكن`,
      body: en ? `Reason: ${reason}. Your unit is saved; pick a place from the list to fix it.` : `السبب: ${reason}. الوحدة محفوظة؛ اختار مكان من القائمة عشان تصلحها.`,
      url: "/app",
      now: new Date()
    }).catch(() => null);
  }
}

module.exports = { PER_HOUR, overLimit, recordProposal, proposeArea, queue, counts, approveCompound, mergeCompound, rejectName, approveArea, mergeArea, rejectArea };
