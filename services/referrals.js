// services/referrals.js — Agency referral program (Release B, N9). Each agency has a short code (made on first view)
// and a sign-up link carrying it. An agency that signs up with a code, or that the owner links to one before it pays,
// records who invited it. On the invited agency's first confirmed plan payment (services/billing.js confirmPayment,
// same transaction) both get one free month: the invited agency on that payment, the inviter on its paid period when
// it is paying now, otherwise as a credit month added to its next confirmed plan payment. Once per invited agency.
"use strict";

const crypto = require("crypto");
const Links = require("../lib/links");

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LEN = 6;
const BONUS_MONTHS = 1;

const normalize = (code) => String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);

function newCode() {
  const bytes = crypto.randomBytes(CODE_LEN);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

const linkOf = (code) => Links.appUrl("signup", { ref: code });

/** The agency's referral code, made the first time it is asked for. */
async function codeOf(db, agencyId) {
  const { rows } = await db.query("SELECT referral_code FROM agencies WHERE id = $1", [agencyId]);
  if (!rows[0]) return null;
  if (rows[0].referral_code) return rows[0].referral_code;
  for (let i = 0; i < 5; i++) {
    try {
      const { rows: set } = await db.query(
        "UPDATE agencies SET referral_code = COALESCE(referral_code, $2) WHERE id = $1 RETURNING referral_code",
        [agencyId, newCode()]
      );
      return set[0].referral_code;
    } catch (err) {
      if (err.code !== "23505") throw err;
    }
  }
  throw new Error("Could not allocate a referral code");
}

/** The approved agency that owns a code, or null. */
async function agencyByCode(db, code) {
  const c = normalize(code);
  if (!c) return null;
  const { rows } = await db.query("SELECT id, name FROM agencies WHERE referral_code = $1 AND approval = 'approved'", [c]);
  return rows[0] || null;
}

/**
 * Records who invited an agency: { ok, referrer } or { error } — referral (unknown code), self, already (has a
 * referrer or was already rewarded), paid (it has paid before, so the program no longer applies).
 */
async function link(db, agencyId, code) {
  const referrer = await agencyByCode(db, code);
  if (!referrer) return { error: "referral" };
  if (referrer.id === agencyId) return { error: "self" };
  const { rows: paid } = await db.query("SELECT 1 FROM payments WHERE agency_id = $1 AND kind = 'plan' AND status = 'confirmed' LIMIT 1", [agencyId]);
  if (paid.length) return { error: "paid" };
  const { rows } = await db.query(
    `UPDATE agencies SET referred_by = $2, updated_at = NOW()
      WHERE id = $1 AND referred_by IS NULL AND referral_rewarded_at IS NULL RETURNING id`,
    [agencyId, referrer.id]
  );
  return rows[0] ? { ok: true, referrer } : { error: "already" };
}

/**
 * Inside confirmPayment's transaction, before the paid period is extended: the extra months this plan payment earns
 * (the invited agency's first payment, plus credit months it was holding) and what happened to the inviter.
 * @returns {Promise<{ bonus: number, referrer: { id, name, credited: boolean } | null }>}
 */
async function onPlanPayment(client, agencyId, { now = new Date() } = {}) {
  const { rows } = await client.query(
    "SELECT referred_by, referral_rewarded_at, referral_credit_months FROM agencies WHERE id = $1 FOR UPDATE",
    [agencyId]
  );
  const a = rows[0];
  if (!a) return { bonus: 0, referrer: null };
  let bonus = a.referral_credit_months || 0;
  let referrer = null;
  if (a.referred_by && !a.referral_rewarded_at) {
    bonus += BONUS_MONTHS;
    const { rows: r } = await client.query("SELECT id, name, pilot, paid_until FROM agencies WHERE id = $1 FOR UPDATE", [a.referred_by]);
    if (r[0]) {
      // Paying now (and not a free pilot): the month goes on its paid period; otherwise it waits as a credit.
      const paying = !r[0].pilot && r[0].paid_until && new Date(r[0].paid_until) > now;
      await client.query(
        paying
          ? "UPDATE agencies SET paid_until = paid_until + make_interval(months => $2), updated_at = NOW() WHERE id = $1"
          : "UPDATE agencies SET referral_credit_months = referral_credit_months + $2, updated_at = NOW() WHERE id = $1",
        [r[0].id, BONUS_MONTHS]
      );
      referrer = { id: r[0].id, name: r[0].name, credited: !paying };
    }
  }
  await client.query(
    `UPDATE agencies SET referral_credit_months = 0,
            referral_rewarded_at = CASE WHEN referred_by IS NOT NULL THEN COALESCE(referral_rewarded_at, $2::timestamptz) ELSE referral_rewarded_at END
      WHERE id = $1`,
    [agencyId, now.toISOString()]
  );
  return { bonus, referrer };
}

/** For /app/plan: the code and link, credit months waiting, who invited this agency, and the agencies it invited. */
async function summary(db, agencyId) {
  const code = await codeOf(db, agencyId);
  const { rows } = await db.query(
    `SELECT a.referral_credit_months AS credit, a.referral_rewarded_at, r.name AS referred_by_name
       FROM agencies a LEFT JOIN agencies r ON r.id = a.referred_by WHERE a.id = $1`,
    [agencyId]
  );
  const { rows: invited } = await db.query(
    "SELECT name, approval, referral_rewarded_at FROM agencies WHERE referred_by = $1 ORDER BY COALESCE(signed_up_at, created_at) DESC LIMIT 50",
    [agencyId]
  );
  const me = rows[0] || {};
  return { code, link: code ? linkOf(code) : null, credit: me.credit || 0, referredBy: me.referred_by_name || null, rewarded: Boolean(me.referral_rewarded_at), invited };
}

/** For /app/owner: every referral, newest first, and agencies that could still be linked to an inviter. */
async function overview(db) {
  const { rows: referrals } = await db.query(
    `SELECT a.id, a.name, a.approval, a.referral_rewarded_at, r.name AS referrer_name, r.referral_credit_months AS referrer_credit
       FROM agencies a JOIN agencies r ON r.id = a.referred_by
      ORDER BY COALESCE(a.signed_up_at, a.created_at) DESC LIMIT 100`
  );
  const { rows: linkable } = await db.query(
    `SELECT a.id, a.name FROM agencies a
      WHERE a.referred_by IS NULL AND a.referral_rewarded_at IS NULL AND a.approval <> 'rejected'
        AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.agency_id = a.id AND p.kind = 'plan' AND p.status = 'confirmed')
      ORDER BY a.name LIMIT 200`
  );
  return { referrals, linkable };
}

module.exports = { BONUS_MONTHS, normalize, newCode, linkOf, codeOf, agencyByCode, link, onPlanPayment, summary, overview };
