// 111: loads the reviewed location list (db/data/location-import-2026-11.json): the full area tree, each compound's area,
// names, aliases, pins and project notes, then gives units with no area their compound's area. Safe to re-run: every step
// finds what is already there, a failing row is skipped (logged) and never stops the rest. Backups of areas, compounds and
// unit locations are kept in *_backup_111 tables (drop them when happy).
"use strict";

const data = require("../data/location-import-2026-11.json");
const { placeKey } = require("../../domain/mapPlaces");

const uniq = (list) => {
  const seen = new Set();
  return list.filter((a) => {
    const k = placeKey(a);
    if (!a || /^[?\s]+$/.test(a) || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

async function up(client) {
  const skipped = [];
  let n = 0;
  // One failing row must not abort the transaction: each risky step runs inside its own savepoint.
  async function guarded(label, fn) {
    const sp = `s${n++}`;
    await client.query(`SAVEPOINT ${sp}`);
    try {
      await fn();
      await client.query(`RELEASE SAVEPOINT ${sp}`);
    } catch (e) {
      await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
      skipped.push(`${label}: ${e.message}`);
    }
  }

  for (const t of ["areas", "map_places"]) {
    await client.query(`CREATE TABLE IF NOT EXISTS ${t}_backup_111 AS SELECT * FROM ${t}`);
    await client.query(`ALTER TABLE ${t}_backup_111 ENABLE ROW LEVEL SECURITY`);
  }
  await client.query("CREATE TABLE IF NOT EXISTS listings_location_backup_111 AS SELECT id, area_id, subzone_id, place_id FROM listings");
  await client.query("ALTER TABLE listings_location_backup_111 ENABLE ROW LEVEL SECURITY");

  // ---- area tree ----
  const ids = new Map(); // path -> area id
  const find = async (parentId, name) =>
    (await client.query("SELECT id FROM areas WHERE name_key = $1 AND parent_id IS NOT DISTINCT FROM $2", [placeKey(name), parentId])).rows[0]?.id || null;
  async function walk(path) {
    let id = null;
    for (const seg of path.split(" > ")) {
      id = await find(id, seg);
      if (!id) return null;
    }
    return id;
  }
  for (const t of data.tree) {
    await guarded(`area ${t.path}`, async () => {
      const segs = t.path.split(" > ");
      const parentId = segs.length > 1 ? ids.get(segs.slice(0, -1).join(" > ")) : null;
      if (segs.length > 1 && !parentId) throw new Error("parent missing");
      let id = await find(parentId, t.name_en);
      if (!id && t.moved_from) {
        id = await walk(t.moved_from);
        if (id) await client.query("UPDATE areas SET parent_id = $2, updated_at = now() WHERE id = $1", [id, parentId]);
      }
      if (id) {
        await client.query(
          `UPDATE areas SET place_type = $2, governorate = $3, google_place_id = COALESCE($4, google_place_id),
             disambiguation_note = COALESCE($5, disambiguation_note), name_ar = COALESCE(name_ar, $6),
             lat = COALESCE(lat, $7), lng = COALESCE(lng, $8) WHERE id = $1`,
          [id, t.place_type, t.governorate, t.google_place_id || null, t.disambiguation || null, t.name_ar || null, t.lat ?? null, t.lng ?? null]
        );
      } else {
        id = (
          await client.query(
            `INSERT INTO areas (parent_id, name_key, name_en, name_ar, lat, lng, place_type, governorate, google_place_id, disambiguation_note, source)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'seed') RETURNING id`,
            [parentId, placeKey(t.name_en), t.name_en, t.name_ar || null, t.lat ?? null, t.lng ?? null, t.place_type, t.governorate, t.google_place_id || null, t.disambiguation || null]
          )
        ).rows[0].id;
      }
      ids.set(t.path, id);
    });
  }

  // ---- duplicates become aliases of the main area (units, compounds and children move across) ----
  const mergeTo = new Map();
  for (const m of data.merges) {
    mergeTo.set(m.from, m.into);
    await guarded(`merge ${m.from}`, async () => {
      const from = await walk(m.from);
      const into = ids.get(m.into);
      if (!into || from === into) return;
      const cur = (await client.query("SELECT aliases FROM areas WHERE id = $1", [into])).rows[0].aliases;
      const extra = [m.from.split(" > ").pop()];
      if (from) {
        const f = (await client.query("SELECT name_en, name_ar, aliases FROM areas WHERE id = $1", [from])).rows[0];
        extra.push(f.name_ar, ...f.aliases);
        await client.query("UPDATE areas SET parent_id = $2 WHERE parent_id = $1", [from, into]);
        await client.query("UPDATE map_places SET subzone_id = $2 WHERE subzone_id = $1", [from, into]);
        await client.query("UPDATE listings SET subzone_id = $2 WHERE subzone_id = $1", [from, into]);
      }
      await client.query("UPDATE areas SET aliases = $2 WHERE id = $1", [into, uniq([...cur, ...extra]).slice(0, 20)]);
      if (!from) return;
      await client.query("DELETE FROM areas WHERE id = $1", [from]);
    });
  }

  // ---- compounds ----
  const placement = (path) => {
    const p = mergeTo.get(path) || path;
    const segs = p.split(" > ");
    const area = ids.get(segs[0]) || null;
    const deepest = segs.length > 1 ? ids.get(p) || null : null;
    return { area_id: area, subzone_id: deepest, leaf: ids.get(p) || null };
  };
  for (const c of data.compounds) {
    await guarded(`compound ${c.name_en}`, async () => {
      const at = placement(c.path);
      if (!at.area_id) throw new Error(`no area for ${c.path}`);
      let row = (await client.query("SELECT id, aliases, name_key FROM map_places WHERE id = $1", [c.id])).rows[0];
      if (!row) row = (await client.query("SELECT id, aliases, name_key FROM map_places WHERE name_key = ANY($1)", [[placeKey(c.name_en), placeKey(c.old_name_en || c.name_en)]])).rows[0];
      const oldNames = [c.old_name_en, c.old_name_ar];
      if (!row) {
        let lat = c.lat ?? null;
        let lng = c.lng ?? null;
        if (lat == null && at.leaf) {
          const a = (await client.query("SELECT lat, lng FROM areas WHERE id = $1", [at.leaf])).rows[0];
          lat = a?.lat ?? null;
          lng = a?.lng ?? null;
        }
        await client.query(
          `INSERT INTO map_places (name_key, name_en, name_ar, developer, district, lat, lng, aliases, source, approved, area_id, subzone_id,
             google_place_id, project_info_en, project_info_ar, project_info_source)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'manual', true, $9, $10, $11, $12, $13, $14)`,
          [placeKey(c.name_en), c.name_en, c.name_ar, c.developer || null, c.district || null, lat, lng, uniq([...c.aliases, ...oldNames]).slice(0, 20), at.area_id, at.subzone_id, c.google_place_id || null, c.info_en || null, c.info_ar || null, c.info_source || null]
        );
        return;
      }
      const aliases = uniq([...c.aliases, ...oldNames, ...row.aliases]).slice(0, 20);
      await client.query(
        `UPDATE map_places SET name_en = $2, name_ar = $3, aliases = $4, area_id = $5, subzone_id = $6,
           lat = COALESCE($7, lat), lng = COALESCE($8, lng), google_place_id = COALESCE($9, google_place_id),
           project_info_en = COALESCE($10, project_info_en), project_info_ar = COALESCE($11, project_info_ar),
           project_info_source = COALESCE($12, project_info_source), updated_at = now() WHERE id = $1`,
        [row.id, c.name_en, c.name_ar, aliases, at.area_id, at.subzone_id, c.lat ?? null, c.lng ?? null, c.google_place_id || null, c.info_en || null, c.info_ar || null, c.info_source || null]
      );
      const key = placeKey(c.name_en);
      if (key !== row.name_key) await guarded(`rename ${c.name_en}`, () => client.query("UPDATE map_places SET name_key = $2 WHERE id = $1", [row.id, key]));
    });
  }

  // ---- duplicate compounds go (only when no unit points at them) ----
  for (const id of data.deletes) {
    await guarded(`delete ${id}`, async () => {
      const used = (await client.query("SELECT count(*)::int AS n FROM listings WHERE place_id = $1", [id])).rows[0].n;
      if (used) throw new Error(`${used} units still use it`);
      await client.query("DELETE FROM map_places WHERE id = $1", [id]);
    });
  }

  // ---- units with no area take their compound's area ----
  await client.query(
    `UPDATE listings l SET area_id = p.area_id, subzone_id = p.subzone_id
       FROM map_places p WHERE l.place_id = p.id AND p.area_id IS NOT NULL AND l.area_id IS NULL`
  );
  if (skipped.length) console.warn(`[111_location_import] ${skipped.length} skipped:\n${skipped.join("\n")}`);
}

module.exports = { up };
