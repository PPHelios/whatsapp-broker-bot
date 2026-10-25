// lib/onboarding.js — Pilot onboarding: one agency, its brokers, roles and branding (idempotent)
"use strict";

const Phone = require("../domain/phone");
const Slug = require("../domain/slug");

const ROLES = ["broker", "agent", "admin", "owner", "manager"];
const HEX = /^#[0-9A-Fa-f]{6}$/;

/** Egyptian mobile in international digits (2010xxxxxxxx); null when not a valid mobile. */
function normalizeEgyptMobile(raw) {
  const d = Phone.normalizePhone(raw);
  return Phone.isEgyptMobile(d) ? d : null;
}

/** Validates an onboarding file; returns { errors, plan } without touching the database. */
function validate(input = {}) {
  const errors = [];
  const a = input.agency || {};
  if (!String(a.name || "").trim()) errors.push("agency.name is required");
  for (const k of ["primary_color", "secondary_color", "brand_color", "accent_color"]) {
    if (a[k] && !HEX.test(a[k])) errors.push(`agency.${k} must be a #RRGGBB colour`);
  }
  if (a.flyer_theme && !["dark", "light"].includes(a.flyer_theme)) errors.push("agency.flyer_theme must be dark or light");
  if (a.logo_url && !/^https:\/\//.test(a.logo_url)) errors.push("agency.logo_url must be an https:// URL");
  if (a.slug !== undefined && a.slug !== null && !Slug.isValidSlug(a.slug)) {
    errors.push("agency.slug must be lower-case letters, digits and dashes (it is the first part of public unit links) and not a reserved word");
  }

  const brokers = Array.isArray(input.brokers) ? input.brokers : [];
  if (!brokers.length) errors.push("at least one broker is required");
  const seen = new Set();
  const plan = brokers.map((b, i) => {
    const phone = normalizeEgyptMobile(b.phone);
    const role = String(b.role || "broker").toLowerCase();
    if (!String(b.name || "").trim()) errors.push(`brokers[${i}].name is required`);
    if (!phone) errors.push(`brokers[${i}].phone "${b.phone}" is not an Egyptian mobile number`);
    if (!ROLES.includes(role)) errors.push(`brokers[${i}].role must be one of ${ROLES.join(", ")}`);
    if (phone && seen.has(phone)) errors.push(`brokers[${i}].phone is listed twice`);
    seen.add(phone);
    return {
      name: String(b.name || "").trim(),
      phone,
      role,
      lang: b.lang === "en" ? "en" : "ar",
      contact_phone: b.contact_phone ? normalizeEgyptMobile(b.contact_phone) || String(b.contact_phone) : null
    };
  });
  if (!plan.some((b) => ["admin", "owner", "manager"].includes(b.role))) {
    errors.push("at least one broker must be admin, owner or manager");
  }
  return { errors, plan };
}

/**
 * Creates or updates the agency (matched by name) and its brokers (matched by phone) in one
 * transaction. A phone that belongs to another agency is an error, never a silent move.
 * The slug comes from the file when given, else it is derived from the name once and then kept
 * (renaming never breaks shared links).
 * @returns {Promise<{ agencyId, slug, created: string[], updated: string[] }>}
 */
async function onboard(pool, input) {
  const { errors, plan } = validate(input);
  if (errors.length) {
    const err = new Error(`Onboarding file is invalid:\n- ${errors.join("\n- ")}`);
    err.code = "INVALID_ONBOARDING";
    throw err;
  }
  const a = input.agency;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const brand = {
      name: a.name.trim(),
      phone: a.phone || null,
      logo_url: a.logo_url || null,
      primary_color: a.primary_color || "#0B132B",
      secondary_color: a.secondary_color || "#D4AF37",
      flyer_theme: a.flyer_theme || "dark",
      slug: a.slug || null
    };
    const { rows: existing } = await client.query("SELECT id FROM agencies WHERE lower(name) = lower($1) LIMIT 1", [brand.name]);
    let agencyId;
    let slug;
    if (brand.slug) {
      const { rows: taken } = await client.query("SELECT 1 FROM agencies WHERE slug = $1 AND lower(name) <> lower($2)", [brand.slug, brand.name]);
      if (taken.length) throw Object.assign(new Error(`slug "${brand.slug}" is already used by another agency`), { code: "SLUG_TAKEN" });
    }
    if (existing.length) {
      agencyId = existing[0].id;
      const { rows } = await client.query(
        `UPDATE agencies SET phone = $2, logo_url = $3, primary_color = $4, secondary_color = $5, flyer_theme = $6,
           slug = COALESCE($7, slug), updated_at = NOW()
         WHERE id = $1 RETURNING slug`,
        [agencyId, brand.phone, brand.logo_url, brand.primary_color, brand.secondary_color, brand.flyer_theme, brand.slug]
      );
      slug = rows[0].slug;
    } else {
      const { rows } = await client.query(
        `INSERT INTO agencies (name, phone, logo_url, primary_color, secondary_color, flyer_theme, slug)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, slug`,
        [brand.name, brand.phone, brand.logo_url, brand.primary_color, brand.secondary_color, brand.flyer_theme, brand.slug]
      );
      agencyId = rows[0].id;
      slug = rows[0].slug;
    }

    const created = [];
    const updated = [];
    for (const b of plan) {
      const { rows } = await client.query("SELECT id, agency_id FROM brokers WHERE phone_normalized = $1", [b.phone]);
      if (rows[0] && rows[0].agency_id !== agencyId) {
        throw Object.assign(new Error(`${b.phone} is already registered with another agency`), { code: "PHONE_TAKEN" });
      }
      if (rows[0]) {
        await client.query(
          `UPDATE brokers SET name = $2, role = $3, preferred_lang = $4, contact_phone = $5, is_active = true WHERE id = $1`,
          [rows[0].id, b.name, b.role, b.lang, b.contact_phone]
        );
        updated.push(b.phone);
      } else {
        await client.query(
          `INSERT INTO brokers (agency_id, phone_number, name, role, preferred_lang, contact_phone, is_active)
           VALUES ($1, $2, $3, $4, $5, $6, true)`,
          [agencyId, b.phone, b.name, b.role, b.lang, b.contact_phone]
        );
        created.push(b.phone);
      }
    }
    await client.query("COMMIT");
    return { agencyId, slug, created, updated };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { ROLES, normalizeEgyptMobile, validate, onboard };
