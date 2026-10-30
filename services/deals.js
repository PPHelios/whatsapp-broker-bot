// services/deals.js — Deals and commission (Release 3 step 10, Q10). A deal is entered by its closing broker (a manager
// may enter it for a broker and correct it later); recording it marks the lead won and, when ticked, the unit sold in
// the same transaction (a unit changed since the review refuses the whole deal). A double tap saves once (idem_key).
// Reads are role-scoped: a broker sees the deals they closed or share in, and only their own share; managers see all.
"use strict";

const Leads = require("./leads");
const Store = require("../lib/listingStore");
const Authz = require("../lib/authz");
const Commission = require("../domain/commission");
const Stages = require("../domain/leadStages");
const { withTransaction } = require("../lib/db");
const Vis = require("../lib/visibility");

const STATUSES = ["pending", "signed", "paid", "cancelled"];
const STATUS_LABELS = {
  pending: ["⏳ لسه", "⏳ Pending"],
  signed: ["✍️ اتمضت", "✍️ Signed"],
  paid: ["💰 اتدفعت", "💰 Paid"],
  cancelled: ["❌ اتلغت", "❌ Cancelled"]
};
const PAGE = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const refLabel = (ref) => `D-${String(ref).padStart(4, "0")}`;
const parseRef = (text) => {
  const m = String(text || "").trim().match(/^[Dd]-?(\d{1,6})$/);
  return m ? Number(m[1]) : null;
};
const statusLabel = (s, lang) => (STATUS_LABELS[s] || [s, s])[lang === "en" ? 1 : 0];
const cleanText = (v, max) => {
  const s = String(v ?? "").replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
};

class DealConflict extends Error {}

async function activeBroker(db, agencyId, id) {
  if (!id || !UUID.test(String(id))) return null;
  const { rows } = await db.query("SELECT id, agency_id, name, role, is_active FROM brokers WHERE id = $1 AND agency_id = $2 AND is_active", [id, agencyId]);
  return rows[0] || null;
}

/**
 * Checks a deal and works out the money, without writing anything (the WhatsApp review card and the web form).
 * @param {Object} input - { leadKey, unitCode, price, mode, pct, amount, external: { pct|amount, name }, splits: [{ brokerId, pct }],
 *                          dealType, status, markSold (true/false/undefined = when the broker may), notes, closingBrokerId }
 * @returns {Promise<{ draft } | { error, ...details }>}
 */
async function prepare(pool, actor, input = {}) {
  const lead = await Leads.getLead(pool, actor, input.leadKey);
  if (!lead) return { error: "lead_not_found" };
  if (!Authz.canEditLead(actor, lead)) return { error: "forbidden" };

  let unit = null;
  if (input.unitCode) {
    unit = await Store.findByCode(pool, actor.agency_id, input.unitCode);
    if (!unit) return { error: "unit_not_found", code: input.unitCode };
  }
  let closer = actor;
  if (input.closingBrokerId && input.closingBrokerId !== actor.id) {
    if (!Authz.isManager(actor)) return { error: "forbidden" };
    closer = await activeBroker(pool, actor.agency_id, input.closingBrokerId);
    if (!closer) return { error: "broker_not_found" };
  }
  const splits = [];
  for (const s of input.splits || []) {
    const b = await activeBroker(pool, actor.agency_id, s.brokerId);
    if (!b) return { error: "broker_not_found" };
    splits.push({ brokerId: b.id, pct: s.pct, name: b.name });
  }
  const price = input.price ?? unit?.price_value ?? null;
  const money = Commission.compute({ price, mode: input.mode, pct: input.pct, amount: input.amount, external: input.external, closingBrokerId: closer.id, splits });
  if (money.errors.length) return { error: money.errors[0], errors: money.errors };

  const mayMarkSold = Boolean(unit && unit.status === "active" && Authz.canEdit(actor, unit));
  if (input.markSold === true && unit && !mayMarkSold) return { error: unit.status === "active" ? "unit_not_yours" : "unit_not_active", code: unit.code };
  const markSold = input.markSold === undefined ? mayMarkSold : Boolean(input.markSold) && mayMarkSold;
  const dealType = ["sale", "rent"].includes(input.dealType) ? input.dealType : unit?.listing_type === "rent" || lead.kind === "tenant" ? "rent" : "sale";
  const names = new Map([[closer.id, closer.name], ...splits.map((s) => [s.brokerId, s.name])]);
  return {
    draft: {
      leadId: lead.id,
      leadRef: lead.ref,
      leadName: lead.name,
      listingId: unit?.id || null,
      unitCode: unit?.code || null,
      unitBrokerId: unit?.broker_id || null,
      unitVersion: unit?.version ?? null,
      dealType,
      price: Number(price),
      mode: input.mode,
      pct: input.mode === "pct" ? Number(input.pct) : null,
      total: money.total,
      external: money.external,
      externalName: cleanText(input.external?.name, 120),
      agencyShare: money.agencyShare,
      shares: money.shares.map((s) => ({ ...s, name: names.get(s.brokerId) || "" })),
      closingBrokerId: closer.id,
      markSold,
      mayMarkSold,
      status: STATUSES.includes(input.status) && input.status !== "cancelled" ? input.status : "pending",
      notes: cleanText(input.notes, 1000)
    },
    input
  };
}

/**
 * Records the deal: the deal and its shares, the lead won (a "deal" event), the unit sold when ticked.
 * @param {Object} opts - { idemKey (one per review card or form), unitVersion (the version shown), now }
 * @returns {Promise<{ ok, deal, duplicate? } | { error }>}
 */
async function createDeal(pool, actor, input, { idemKey = null, unitVersion = null, now = new Date() } = {}) {
  // The same form or button again: the deal it saved (before any check, since the unit is sold by then).
  if (idemKey) {
    const dup = await pool.query("SELECT * FROM deals WHERE agency_id = $1 AND idem_key = $2", [actor.agency_id, idemKey]);
    if (dup.rows[0]) return { ok: true, deal: dup.rows[0], duplicate: true };
  }
  const prep = await prepare(pool, actor, input);
  if (prep.error) return prep;
  const d = prep.draft;
  try {
    return await withTransaction(pool, async (client) => {
      // One writer per lead: a second tap waits here, then finds the first deal.
      const locked = await client.query("SELECT id, stage FROM leads WHERE " + Vis.leads("leads") + " AND id = $1 AND agency_id = $2 FOR UPDATE", [d.leadId, actor.agency_id]);
      if (!locked.rows.length) return { error: "lead_not_found" };
      if (idemKey) {
        const dup = await client.query("SELECT * FROM deals WHERE agency_id = $1 AND idem_key = $2", [actor.agency_id, idemKey]);
        if (dup.rows[0]) return { ok: true, deal: dup.rows[0], duplicate: true };
      }
      const lead = await Leads.getLead(client, actor, d.leadId);
      const seq = await client.query("UPDATE agencies SET deal_ref_seq = deal_ref_seq + 1 WHERE id = $1 RETURNING deal_ref_seq", [actor.agency_id]);
      const { rows } = await client.query(
        `INSERT INTO deals (agency_id, ref, lead_id, listing_id, unit_code, closing_broker_id, created_by_broker_id, deal_type, price, commission_mode,
                            commission_pct, commission_total, external_share, external_name, status, client_name, client_phone, notes, idem_key,
                            closed_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $20, $20) RETURNING *`,
        [
          actor.agency_id,
          seq.rows[0].deal_ref_seq,
          d.leadId,
          d.listingId,
          d.unitCode,
          d.closingBrokerId,
          actor.id,
          d.dealType,
          d.price,
          d.mode,
          d.pct,
          d.total,
          d.external,
          d.externalName,
          d.status,
          lead?.name || null,
          lead?.phone_e164 || null,
          d.notes,
          idemKey,
          now.toISOString()
        ]
      );
      const deal = rows[0];
      for (const s of d.shares) {
        await client.query("INSERT INTO deal_splits (deal_id, agency_id, broker_id, pct, amount) VALUES ($1, $2, $3, $4, $5)", [deal.id, actor.agency_id, s.brokerId, s.pct, s.amount]);
      }
      // C8: a deal on a catalogue unit gets its developer commission row.
      await require("./commissions").ensureForDeal(client, deal);
      await Leads.recordDeal(client, actor, d.leadId, { dealId: deal.id, ref: deal.ref, price: d.price, unitCode: d.unitCode }, now);
      if (d.markSold) {
        const listing = await Store.findByCode(client, actor.agency_id, d.unitCode, { forUpdate: true });
        const res = listing ? await Store.applyListingPatch(client, actor, { listing, patch: { status: "sold" }, expectedVersion: unitVersion ?? d.unitVersion }) : { conflict: true };
        if (!res.listing) throw new DealConflict(res.forbidden ? "unit_not_yours" : "unit_conflict");
      }
      return { ok: true, deal };
    });
  } catch (err) {
    if (err instanceof DealConflict) return { error: err.message, code: d.unitCode };
    throw err;
  }
}

/** A deal with its shares, if the broker may see it; a broker sees only their own share. */
async function getDeal(pool, actor, key) {
  const ref = typeof key === "number" ? key : parseRef(key);
  const where = ref ? "d.ref = $2" : UUID.test(String(key)) ? "d.id = $2" : null;
  if (!where) return null;
  const { rows } = await pool.query(
    `SELECT d.*, l.ref AS lead_ref, b.name AS closing_broker_name FROM deals d
       LEFT JOIN leads l ON l.id = d.lead_id AND l.agency_id = d.agency_id
       LEFT JOIN brokers b ON b.id = d.closing_broker_id AND b.agency_id = d.agency_id
      WHERE ${Vis.leads("l")} AND d.agency_id = $1 AND ${where}`,
    [actor.agency_id, ref || key]
  );
  const deal = rows[0];
  if (!deal) return null;
  const sh = await pool.query(
    "SELECT s.broker_id, s.pct, s.amount, b.name FROM deal_splits s JOIN brokers b ON b.id = s.broker_id WHERE s.deal_id = $1 ORDER BY s.amount DESC, b.name",
    [deal.id]
  );
  deal.shares = sh.rows;
  if (!Authz.canViewDeal(actor, deal)) return null;
  if (!Authz.isManager(actor)) deal.shares = deal.shares.filter((s) => s.broker_id === actor.id);
  return deal;
}

/** Role-scoped list, newest first, with the viewer's own share. */
async function listDeals(pool, actor, { status = null, limit = PAGE, offset = 0 } = {}) {
  const params = [actor.agency_id, actor.id];
  const where = ["d.agency_id = $1"];
  if (!Authz.isManager(actor)) where.push("(d.closing_broker_id = $2 OR EXISTS (SELECT 1 FROM deal_splits s WHERE s.deal_id = d.id AND s.broker_id = $2))");
  if (STATUSES.includes(status)) {
    params.push(status);
    where.push(`d.status = $${params.length}`);
  }
  params.push(limit + 1, offset);
  const { rows } = await pool.query(
    `SELECT d.id, d.ref, d.unit_code, d.deal_type, d.price, d.commission_total, d.external_share, d.status, d.closed_at, d.client_name,
            d.closing_broker_id, b.name AS closing_broker_name, l.ref AS lead_ref,
            (SELECT amount FROM deal_splits s WHERE s.deal_id = d.id AND s.broker_id = $2) AS my_share
       FROM deals d LEFT JOIN brokers b ON b.id = d.closing_broker_id AND b.agency_id = d.agency_id
       LEFT JOIN leads l ON l.id = d.lead_id AND l.agency_id = d.agency_id
      WHERE ${Vis.leads("l")} AND ${where.join(" AND ")} ORDER BY d.closed_at DESC, d.ref DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { rows: rows.slice(0, limit).map((r) => ({ ...r, my_share: r.my_share == null ? null : Number(r.my_share) })), more: rows.length > limit };
}

/** Per Cairo month (cancelled deals left out): managers get the agency's totals, a broker their own share. */
async function monthlyTotals(pool, actor, { months = 6, now = new Date() } = {}) {
  const since = Stages.cairoDayAt(new Date(now.getTime() - (months - 1) * 31 * 24 * 3600 * 1000), 0, 0);
  const month = "to_char(d.closed_at AT TIME ZONE 'Africa/Cairo', 'YYYY-MM')";
  if (Authz.isManager(actor)) {
    const { rows } = await pool.query(
      `SELECT ${month} AS month, count(*)::int AS deals, sum(d.price)::bigint AS volume, sum(d.commission_total)::bigint AS commission,
              sum(d.external_share)::bigint AS external, sum(d.commission_total - d.external_share)::bigint AS agency
         FROM deals d WHERE d.agency_id = $1 AND d.status <> 'cancelled' AND d.closed_at >= $2 GROUP BY 1 ORDER BY 1 DESC`,
      [actor.agency_id, since.toISOString()]
    );
    return rows.map((r) => ({ ...r, volume: Number(r.volume), commission: Number(r.commission), external: Number(r.external), agency: Number(r.agency) }));
  }
  const { rows } = await pool.query(
    `SELECT ${month} AS month, count(*)::int AS deals, sum(s.amount)::bigint AS mine
       FROM deals d JOIN deal_splits s ON s.deal_id = d.id AND s.broker_id = $2
      WHERE d.agency_id = $1 AND d.status <> 'cancelled' AND d.closed_at >= $3 GROUP BY 1 ORDER BY 1 DESC`,
    [actor.agency_id, actor.id, since.toISOString()]
  );
  return rows.map((r) => ({ ...r, mine: Number(r.mine) }));
}

/**
 * A correction. The status moves by the closing broker or a manager; the money (price, commission, external share,
 * splits) only by a manager, and the shares are worked out again. Optimistic lock on version.
 * @returns {Promise<{ ok, deal } | { conflict } | { error }>}
 */
async function updateDeal(pool, actor, key, change = {}, { version = null, now = new Date() } = {}) {
  const deal = await getDeal(pool, actor, key);
  if (!deal) return { error: "not_found" };
  if (!Authz.canEditDeal(actor, deal)) return { error: "forbidden" };
  const money = ["price", "mode", "pct", "amount", "external", "splits"].some((k) => change[k] !== undefined);
  if (money && !Authz.isManager(actor)) return { error: "forbidden" };
  if (change.status !== undefined && !STATUSES.includes(change.status)) return { error: "status" };

  let computed = null;
  if (money) {
    const full = await pool.query("SELECT broker_id, pct FROM deal_splits WHERE deal_id = $1 AND broker_id <> $2", [deal.id, deal.closing_broker_id]);
    computed = Commission.compute({
      price: change.price ?? deal.price,
      mode: change.mode ?? deal.commission_mode,
      pct: change.pct ?? deal.commission_pct,
      amount: change.amount ?? (deal.commission_mode === "amount" ? deal.commission_total : null),
      external: change.external !== undefined ? change.external : { amount: Number(deal.external_share) },
      closingBrokerId: deal.closing_broker_id,
      splits: change.splits ?? full.rows.map((r) => ({ brokerId: r.broker_id, pct: Number(r.pct) }))
    });
    if (computed.errors.length) return { error: computed.errors[0] };
    for (const s of computed.shares) if (!(await activeBroker(pool, actor.agency_id, s.brokerId)) && s.brokerId !== deal.closing_broker_id) return { error: "broker_not_found" };
  }
  return withTransaction(pool, async (client) => {
    const fields = {};
    if (change.status !== undefined) fields.status = change.status;
    if (change.notes !== undefined) fields.notes = cleanText(change.notes, 1000);
    if (computed) {
      const mode = change.mode ?? deal.commission_mode;
      Object.assign(fields, {
        price: Number(change.price ?? deal.price),
        commission_mode: mode,
        commission_pct: mode === "pct" ? Number(change.pct ?? deal.commission_pct) : null,
        commission_total: computed.total,
        external_share: computed.external
      });
      if (change.external?.name !== undefined) fields.external_name = cleanText(change.external.name, 120);
    }
    const cols = Object.keys(fields);
    if (!cols.length) return { unchanged: true, deal };
    const params = [deal.id, actor.agency_id, ...cols.map((c) => fields[c]), now.toISOString()];
    let sql = `UPDATE deals SET ${cols.map((c, i) => `${c} = $${i + 3}`).join(", ")}, updated_at = $${cols.length + 3}, version = version + 1 WHERE id = $1 AND agency_id = $2`;
    if (version !== null && version !== undefined && version !== "") {
      params.push(Number(version));
      sql += ` AND version = $${params.length}`;
    }
    const upd = await client.query(`${sql} RETURNING *`, params);
    if (!upd.rows[0]) return { conflict: true, deal };
    if (computed) {
      await client.query("DELETE FROM deal_splits WHERE deal_id = $1", [deal.id]);
      for (const s of computed.shares) {
        await client.query("INSERT INTO deal_splits (deal_id, agency_id, broker_id, pct, amount) VALUES ($1, $2, $3, $4, $5)", [deal.id, actor.agency_id, s.brokerId, s.pct, s.amount]);
      }
    }
    if (fields.status !== undefined) await require("./commissions").onDealChanged(client, upd.rows[0]);
    return { ok: true, deal: upd.rows[0] };
  });
}

module.exports = { STATUSES, refLabel, parseRef, statusLabel, prepare, createDeal, getDeal, listDeals, monthlyTotals, updateDeal };
