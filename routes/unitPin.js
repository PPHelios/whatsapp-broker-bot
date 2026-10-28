// routes/unitPin.js — A location pin sent to the bot becomes a unit's agency-only location: the bot offers the unit
// the broker just looked at and their newest units as buttons ("pin:<code>:<lat>:<lng>"); a tap saves it
// (services/unitPrivacy.js checks the broker may edit that unit). The pin never reaches search or client pages.
"use strict";

const Authz = require("../lib/authz");
const Privacy = require("../services/unitPrivacy");
const { reply, replyButtons } = require("../lib/dispatcher");
const { getRecentBrokerListing } = require("./commandState");

const round = (n) => Math.round(Number(n) * 1e6) / 1e6;

/** A pin arrived: ask which unit it is for. */
async function offerPin(broker, message, ctx) {
  const { pool, lang } = ctx;
  const en = lang === "en";
  const lat = Number(message.location?.latitude);
  const lng = Number(message.location?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return false;
  const recent = await getRecentBrokerListing(pool, broker.id, ctx.recentBrokerListings);
  const { rows } = await pool.query(
    `SELECT code, broker_id, agency_id FROM listings WHERE agency_id = $1 AND status = 'active' AND ($2::boolean OR broker_id = $3)
      ORDER BY (code = $4) DESC, updated_at DESC NULLS LAST LIMIT 3`,
    [broker.agency_id, Authz.isManager(broker), broker.id, recent || ""]
  );
  const units = rows.filter((r) => Authz.canEdit(broker, r));
  if (!units.length) {
    await reply(broker, en ? "📍 Got the location, but you have no unit to put it on yet. Add the unit first." : "📍 وصل اللوكيشن، بس مفيش وحدة ليك تتحط عليها. ضيف الوحدة الأول.");
    return true;
  }
  await replyButtons(
    broker,
    en ? "📍 Which unit is this location for? It stays inside the agency (never in search or client links)." : "📍 اللوكيشن ده لأنهي وحدة؟ هيفضل جوه الوكالة بس (مش في البحث ولا روابط العملاء).",
    units.map((u) => ({ id: `pin:${u.code}:${round(lat)}:${round(lng)}`, title: `📍 ${u.code}`.slice(0, 20) }))
  );
  return true;
}

/** The broker picked the unit: save the pin. */
async function handlePinButton(broker, replyId, ctx) {
  const m = String(replyId).match(/^pin:([^:]+):(-?\d+(?:\.\d+)?):(-?\d+(?:\.\d+)?)$/);
  if (!m) return false;
  const { pool, lang } = ctx;
  const en = lang === "en";
  const { rows } = await pool.query("SELECT * FROM listings WHERE agency_id = $1 AND code = $2 LIMIT 1", [broker.agency_id, m[1]]);
  const out = rows[0] ? await Privacy.setPin(pool, broker, rows[0], { lat: Number(m[2]), lng: Number(m[3]) }, { source: "bot" }) : { ok: false };
  await reply(
    broker,
    out.ok
      ? en ? `✅ Location saved on ${m[1]} (agency only).` : `✅ اللوكيشن اتحفظ على ${m[1]} (للوكالة بس).`
      : en ? "⚠️ You can't change that unit." : "⚠️ مش مسموح تعدل الوحدة دي."
  );
  return true;
}

module.exports = { offerPin, handlePinButton };
