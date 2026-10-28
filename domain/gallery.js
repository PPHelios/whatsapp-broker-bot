// domain/gallery.js — A project's photo gallery (F23), pure: the prompt that sorts one image or PDF page (a render, an
// amenity, the master plan, or a unit layout with its type, area, bedrooms and label), the answer checked, and the
// rule that matches a layout to the project's units. A match needs the type and the area (within 3%, or the unit's
// area range); anything less certain waits for a manager.
"use strict";

const VERSION = "gallery-v1";
const MAX_FILES = 10;
const KINDS = ["render", "amenity", "master_plan", "layout", "other"];
const TYPES = ["apartment", "duplex", "penthouse", "studio", "villa", "twinhouse", "townhouse", "chalet", "office", "shop", "clinic", "other"];
const AREA_TOLERANCE = 0.03;

const PROMPT = `You look at ONE image or PDF page from an Egyptian real-estate project's marketing material.
Return JSON only: {"kind":"render|amenity|master_plan|layout|other","unit_type":"...","area":120,"bedrooms":3,"label":"Type A"}.
- kind: render = an outside or inside view of the buildings; amenity = club, pool, gym, park; master_plan = the whole
  compound's map; layout = one unit's floor plan; other = anything else (text pages, logos, price lists).
- Only for a layout: unit_type is one of ${TYPES.join(", ")}; area is the total built-up area in m² as written (BUA,
  gross); bedrooms is the number of bedrooms; label is the model or type name written on it (e.g. "Type A", "V2").
- Leave out anything the image does not show. Never guess.`;

const parseJson = (text) => {
  try {
    return JSON.parse(String(text || "").replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    return null;
  }
};
const posNum = (v, max) => (Number.isFinite(Number(v)) && Number(v) > 0 && Number(v) <= max ? Number(v) : null);

/** One answer → { result: { kind, layout } } | { error }. */
function classify(text) {
  const d = parseJson(text);
  if (!d || typeof d !== "object") return { error: "AI_BAD_JSON" };
  const kind = KINDS.includes(d.kind) ? d.kind : "other";
  const layout =
    kind === "layout"
      ? {
          unit_type: TYPES.includes(d.unit_type) ? d.unit_type : null,
          area: posNum(d.area, 5000),
          bedrooms: Number.isInteger(Number(d.bedrooms)) && Number(d.bedrooms) >= 0 && Number(d.bedrooms) <= 10 && d.bedrooms !== null && d.bedrooms !== "" ? Number(d.bedrooms) : null,
          label: String(d.label || "").replace(/\s+/g, " ").trim().slice(0, 40) || null
        }
      : {};
  return { result: { kind, layout } };
}

/** The gallery role of a kind: layouts attach to units; text and logos stay hidden; the rest is shared. */
const roleOf = (kind) => (kind === "layout" ? "layout" : kind === "other" ? "hidden" : "shared");

/**
 * The units a layout fits: same type, same bedrooms when both are known, and an area within 3% (or inside the unit's
 * area range). → { status: "matched", ids } when at least one unit fits on type and area; otherwise "unsure".
 */
function matchUnits(layout, units) {
  if (!layout?.area) return { status: "unsure", ids: [] };
  const ids = units
    .filter((u) => !layout.unit_type || !u.property_type || u.property_type === layout.unit_type)
    .filter((u) => layout.bedrooms === null || layout.bedrooms === undefined || u.bedrooms === null || u.bedrooms === undefined || Number(u.bedrooms) === layout.bedrooms)
    .filter((u) => {
      const from = Number(u.area_value);
      if (!from) return false;
      const to = Number(u.details?.area_to) || from;
      return layout.area >= from * (1 - AREA_TOLERANCE) && layout.area <= to * (1 + AREA_TOLERANCE);
    })
    .map((u) => u.id);
  return ids.length ? { status: "matched", ids } : { status: "unsure", ids: [] };
}

module.exports = { VERSION, MAX_FILES, KINDS, TYPES, PROMPT, classify, roleOf, matchUnits };
