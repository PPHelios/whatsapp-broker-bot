// scripts/seed-poc.js — The POC demo agency: back up, clean the old test data, and load a demo set through the app's own
// services (so codes, owner profiles, events and flags are exactly what the app would make).
// Usage: node --env-file=.env scripts/seed-poc.js <backup|clean|seed|all> [--agency <id>] [--out <backup.json>]
//   backup  writes every row of the agency (and the other agencies) to a JSON file
//   clean   removes the other agencies and the agency's units, leads, deals, owners, viewings, notifications and drafts;
//           operation_logs, credit_actions, plans and the search vocabulary are kept
//   seed    adds the demo brokers, units, owners, leads, flags, viewings and deals (needs the agency's owner and a manager)
// No notification is sent while it runs; demo brokers have made-up numbers and no Telegram link.
"use strict";

const fs = require("fs");
const { withTransaction } = require("../lib/db");
const L = require("../lib/listing");
const Rules = require("../domain/fieldRules");

const DAY = 24 * 3600 * 1000;
const DEMO_BROKERS = [
  { name: "Sara Hassan", phone: "01010000011", lang: "en" },
  { name: "Omar Adel", phone: "01010000012", lang: "ar" }
];

/* ---------------------------------------------------------------------- */
/* Backup and clean                                                        */
/* ---------------------------------------------------------------------- */

const BACKUP_TABLES = ["agencies", "brokers", "listings", "leads", "lead_events", "deals", "viewings", "saved_searches", "unit_owners", "notifications"];

async function backup(pool, file) {
  const out = { taken_at: new Date().toISOString() };
  for (const t of BACKUP_TABLES) out[t] = (await pool.query(`SELECT * FROM ${t}`)).rows;
  fs.mkdirSync(require("path").dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out));
  return Object.fromEntries(BACKUP_TABLES.map((t) => [t, out[t].length]));
}

/** Everything under the agency that is demo or test data; counters go back to zero so the demo codes start at 1. */
const CLEAN_TABLES = ["deals", "viewings", "saved_searches", "leads", "unit_owners", "listings", "notifications", "inbound_messages", "web_imports", "broker_sessions", "share_links"];

async function clean(pool, agencyId) {
  return withTransaction(pool, async (db) => {
    const dropped = {};
    const others = await db.query("DELETE FROM agencies WHERE id <> $1", [agencyId]);
    dropped.other_agencies = others.rowCount;
    for (const t of CLEAN_TABLES) {
      const col = (await db.query("SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'agency_id'", [t])).rowCount ? "agency_id" : null;
      if (!col) continue;
      dropped[t] = (await db.query(`DELETE FROM ${t} WHERE agency_id = $1`, [agencyId])).rowCount;
    }
    await db.query("DELETE FROM web_rate_limits");
    await db.query("DELETE FROM web_login_tokens");
    await db.query("DELETE FROM passkey_challenges");
    await db.query("UPDATE agencies SET lead_ref_seq = 0, deal_ref_seq = 0, unit_code_seq = 0 WHERE id = $1", [agencyId]);
    return dropped;
  });
}

/* ---------------------------------------------------------------------- */
/* Demo data                                                               */
/* ---------------------------------------------------------------------- */

const PLANS = [
  { plan_id: "p8", name_ar: "خطة 8 سنوات", years: 8, down_payment_pct: 10, frequency: "quarterly" },
  { plan_id: "p5", name_ar: "خطة 5 سنوات", years: 5, down_payment_pct: 20, frequency: "quarterly" }
];

// who: index into the brokers (0 Karim, 1 Mahmoud, 2 Sara, 3 Omar), "m" the manager, "o" the agency owner.
// owner: [name, phone] of the unit's owner (the same phone is the same owner profile).
const UNITS = [
  { n: 1, who: 0, type: "apartment", sale: 8_500_000, area: 150, beds: 3, baths: 2, compound: "Hyde Park", district: "New Cairo", fin: "fully_finished", feat: ["north_facing", "view_garden", "parking"], owner: ["Tarek Fawzy", "01010010001"], secret: { unit_no: "B-14", address: "Building 14, Hyde Park, New Cairo", commission: "2%" }, pin: [30.0123, 31.4567] },
  { n: 2, who: 2, type: "apartment", sale: 6_200_000, area: 110, beds: 2, baths: 2, compound: "Mivida", district: "New Cairo", fin: "semi_finished", feat: ["balcony", "elevator"], owner: ["Dina Mostafa", "01010010002"] },
  { n: 3, who: 1, type: "villa", sale: 28_000_000, area: 380, beds: 4, baths: 4, compound: "Palm Hills New Cairo", district: "New Cairo", fin: "super_lux", feat: ["private_garden", "private_pool", "driver_room"], owner: ["Hossam Gamal", "01010010003"], secret: { unit_no: "V-22", commission: "1.5%" }, pin: [30.0301, 31.4702] },
  { n: 4, who: 3, type: "townhouse", sale: 13_500_000, area: 230, beds: 3, baths: 3, compound: "Mountain View iCity", district: "New Cairo", fin: "fully_finished", feat: ["corner", "private_garden"], owner: ["Ahmed Zaki", "01010010004"] },
  { n: 5, who: "m", type: "duplex", sale: 19_000_000, area: 280, beds: 4, baths: 3, compound: "Katameya Heights", district: "New Cairo", fin: "super_lux", feat: ["terrace", "roof", "view_landscape"], owner: ["Tarek Fawzy", "01010010001"] },
  { n: 6, who: 2, type: "penthouse", sale: 16_000_000, area: 210, beds: 3, baths: 3, compound: "Sodic Eastown", district: "New Cairo", fin: "fully_finished", feat: ["roof", "view_landscape", "terrace"] },
  { n: 7, who: 0, type: "studio", sale: 3_100_000, area: 55, beds: 1, baths: 1, compound: "Zamalek", district: "Zamalek", fin: "fully_finished", feat: ["elevator", "ac_installed"], archived: true },
  { n: 8, who: 1, type: "apartment", sale: 7_800_000, area: 170, beds: 3, baths: 2, compound: "Sarayat El Maadi", district: "Maadi", fin: "fully_finished", feat: ["elevator", "parking"], owner: ["Mona Adly", "01010010005"], ready: true },
  { n: 9, who: 3, type: "apartment", sale: 7_200_000, area: 160, beds: 3, baths: 2, compound: "Beverly Hills", district: "Sheikh Zayed", fin: "fully_finished", feat: ["view_pool", "parking"], owner: ["Samir Helal", "01010010006"], sold: true },
  { n: 10, who: "o", type: "villa", sale: 45_000_000, area: 520, beds: 5, baths: 5, compound: "Allegria", district: "Sheikh Zayed", fin: "ultra_super_lux", feat: ["private_pool", "private_garden", "smart_home"], owner: ["Wael Sadek", "01010010007"], private: true, pin: [30.0201, 30.9801] },
  { n: 11, who: 0, type: "chalet", sale: 9_500_000, area: 120, beds: 2, baths: 2, compound: "Marassi", district: "North Coast", fin: "fully_finished", feat: ["view_sea", "balcony"] },
  { n: 12, who: 2, type: "twinhouse", sale: 17_000_000, area: 300, beds: 4, baths: 4, compound: "Palm Hills October", district: "6th of October", fin: "fully_finished", feat: ["corner", "private_garden"], owner: ["Hossam Gamal", "01010010003"] },
  { n: 13, who: 3, type: "apartment", sale: 5_400_000, area: 140, beds: 3, baths: 2, compound: "Capital Heights", district: "New Capital", fin: "semi_finished", feat: ["elevator"], down: 1_500_000 },
  { n: 14, who: 1, type: "apartment", rent: 22_000, area: 120, beds: 2, baths: 2, compound: "Sarayat El Maadi", district: "Maadi", fin: "fully_finished", furn: "furnished", feat: ["furnished", "ac_installed", "kitchen_installed"], owner: ["Mona Adly", "01010010005"] },
  { n: 15, who: 0, type: "apartment", rent: 30_000, area: 150, beds: 3, baths: 2, compound: "Fifth Settlement", district: "New Cairo", fin: "fully_finished", furn: "unfurnished", feat: ["ac_installed", "parking"], rented: true },
  { n: 16, who: 2, type: "office", rent: 35_000, area: 85, beds: 0, baths: 1, compound: "90th Street", district: "New Cairo", fin: "fully_finished", feat: ["elevator", "parking"] },
  { n: 17, who: 3, type: "shop", rent: 60_000, area: 40, beds: 0, baths: 1, compound: "Korba", district: "Heliopolis", fin: "fully_finished", feat: [] },
  { n: 18, who: "m", type: "villa", rent: 90_000, area: 400, beds: 4, baths: 4, compound: "Beverly Hills", district: "Sheikh Zayed", fin: "super_lux", furn: "furnished", feat: ["private_pool", "furnished", "private_garden"], owner: ["Samir Helal", "01010010006"] },
  { n: 19, who: 1, type: "shop", sale: 5_500_000, area: 60, beds: 0, baths: 1, compound: "Abbas El Akkad", district: "Nasr City", fin: "fully_finished", feat: ["elevator"] },
  { n: 20, who: 3, type: "office", sale: 9_000_000, area: 120, beds: 0, baths: 2, compound: "Smart Village", district: "6th of October", fin: "fully_finished", feat: ["elevator", "parking", "security"] },
  { n: 21, who: 0, type: "land", sale: 6_000_000, area: 600, beds: 0, baths: 0, compound: "Sixth of October Industrial", district: "6th of October", feat: [], stale: true },
  { n: 22, who: 2, type: "clinic", sale: 4_200_000, area: 70, beds: 0, baths: 1, compound: "Korba", district: "Heliopolis", fin: "fully_finished", feat: ["elevator"] },
  { n: 23, who: "m", type: "apartment", primary: 9_800_000, area: 160, beds: 3, baths: 2, compound: "Mountain View iCity", district: "New Cairo", fin: "core_and_shell", feat: ["view_landscape"], delivery: 2028, quarter: 2 },
  { n: 24, who: "m", type: "villa", primary: 24_000_000, area: 330, beds: 4, baths: 4, compound: "Sodic Villette", district: "New Cairo", fin: "semi_finished", feat: ["private_garden"], delivery: 2029, quarter: 1 }
];

function draftOf(u) {
  const price = u.sale || u.rent || u.primary;
  const d = {
    property_type: u.type,
    listing_type: u.rent ? "rent" : "sale",
    market: u.primary ? "primary" : "resale",
    price_value: price,
    area_value: u.area,
    bedrooms: u.beds,
    bathrooms: u.baths,
    compound: u.compound,
    district: u.district,
    city: u.district,
    finishing: u.fin || null,
    furnishing: u.furn || null,
    feature_keys: u.feat,
    details: {}
  };
  if (u.down) d.down_payment_value = u.down;
  if (u.primary) {
    d.delivery_year = u.delivery;
    d.delivery_quarter = u.quarter;
    d.payment_terms = { plans: PLANS };
  } else if (u.ready) {
    d.is_ready = true;
  }
  if (u.owner) {
    d.details.owner_name = u.owner[0];
    d.details.owner_phone = u.owner[1];
  }
  Object.assign(d.details, u.secret || {});
  return d;
}

const t = (days) => new Date(Date.now() + days * DAY);

// Leads: stage, assignee (broker index, "m" manager, "o" owner or null = unassigned pool), what happens next.
const LEADS = [
  { n: 1, name: "Ahmed Samir", phone: "01020010001", kind: "buyer", source: "Facebook", to: 0, stage: "interested", note: "Wants 3 bedrooms in New Cairo, budget up to 10M.", request: { listing_type: "sale", type: "apartment", price_max: 10_000_000, bedrooms_min: 3, place: "New Cairo" } },
  { n: 2, name: "Mona Khaled", phone: "01020010002", kind: "buyer", source: "Instagram", to: 2, stage: "new" },
  { n: 3, name: "Youssef Hany", phone: "01020010003", kind: "tenant", source: "WhatsApp", to: 1, stage: "viewing", viewing: { unit: 14, days: 1, hour: 17, place: "Sarayat El Maadi gate 2" } },
  { n: 4, name: "Hala Mostafa", phone: "01020010004", kind: "buyer", source: "Referral", to: 3, stage: "negotiation", deal: { unit: 2, status: "pending", mode: "pct", pct: 2.5, external: { pct: 25, name: "Partner agency" } } },
  { n: 5, name: "Karim Adel", phone: "01020010005", kind: "buyer", source: "Property Finder", to: 3, deal: { unit: 9, status: "signed", mode: "pct", pct: 2 } },
  { n: 6, name: "Nour Ibrahim", phone: "01020010006", kind: "tenant", source: "OLX-Dubizzle", to: 0, deal: { unit: 15, status: "paid", mode: "amount", amount: 30_000, dealType: "rent" } },
  { n: 7, name: "Tamer Fathy", phone: "01020010007", kind: "buyer", source: "Google", to: 1, stage: "lost", lost: "Bought from another agency" },
  { n: 8, name: "Salma Reda", phone: "01020010008", kind: "buyer", source: "Walk-in", to: 2, stage: "contacted", overdue: true },
  { n: 9, name: "Hossam Gamal", phone: "01010010003", kind: "seller", source: "Referral", to: 1, stage: "interested", note: "Owns two units (V-22 and the Palm Hills twin house)." },
  { n: 10, name: "Dalia Fouad", phone: "01020010010", kind: "landlord", source: "WhatsApp", to: 0, stage: "contacted", note: "Has a furnished flat to rent in Maadi." },
  { n: 11, name: "Mazen Wael", phone: "01020010011", kind: "buyer", source: "TikTok", to: null, stage: "new" },
  { n: 12, name: "Rana Sherif", phone: "01020010012", kind: "buyer", source: "Unit link", to: 0, stage: "interested", flag: "Client wants a 5% discount on the first unit. Can I offer it?" },
  { n: 13, name: "Omar Lotfy", phone: "01020010013", kind: "buyer", source: "Call", to: 1, stage: "negotiation", flag: "Needs a payment plan longer than 8 years.", handled: "Offer the 8-year plan with 10% down; the owner agreed to it." },
  { n: 14, name: "Basma Gamal", phone: "01020010014", kind: "tenant", source: "Facebook", to: 2, stage: "interested", request: { listing_type: "rent", type: "apartment", price_max: 25_000, bedrooms_min: 2 } },
  { n: 15, name: "Hesham Anwar", phone: "01020010015", kind: "buyer", source: "Instagram", to: 0, stage: "viewing", viewing: { unit: 1, days: 2, hour: 15, place: "Hyde Park, gate 1" } },
  { n: 16, name: "Dina Fawzy", phone: "01020010016", kind: "buyer", source: "Referral", to: 3, stage: "contacted", request: { listing_type: "sale", type: "villa", price_max: 30_000_000 } },
  { n: 17, name: "أحمد سمير", phone: "01020010017", kind: "buyer", source: "Facebook", to: 0, stage: "new", note: "Possibly the same person as Ahmed Samir (L-0001): try the merge." },
  { n: 18, name: "Marwa Helal", phone: "01020010018", kind: "buyer", source: "Referral", to: "o", stage: "interested", private: true, note: "VIP client of the agency owner." },
  { n: 19, name: "Khaled Nabil", phone: "01020010019", kind: "buyer", source: "Facebook", to: 1, stage: "new", note: "Facebook lead ad: Palm Hills campaign." },
  { n: 20, name: "Ola Mahdy", phone: "01020010020", kind: "tenant", source: "WhatsApp", to: 3, stage: "lost", lost: "Budget too low" }
];

async function resolveActors(pool, agencyId) {
  const get = async (where, params = []) => (await pool.query(`SELECT * FROM brokers WHERE agency_id = $1 AND is_active ${where} ORDER BY created_at, id`, [agencyId, ...params])).rows;
  const owner = (await get("AND role = 'owner'"))[0];
  const manager = (await get("AND role IN ('manager', 'admin')"))[0];
  if (!owner || !manager) throw new Error("The agency needs an owner and a manager before seeding.");
  let brokers = await get("AND role = 'broker' AND phone_normalized NOT IN ('" + DEMO_BROKERS.map((b) => "2" + b.phone).join("','") + "')");
  for (const d of DEMO_BROKERS) {
    const digits = "2" + d.phone;
    const found = await pool.query("SELECT 1 FROM brokers WHERE phone_normalized = $1", [digits]);
    if (!found.rowCount) {
      await pool.query("INSERT INTO brokers (agency_id, phone_number, name, role, preferred_lang, is_active) VALUES ($1, $2, $3, 'broker', $4, true)", [agencyId, digits, d.name, d.lang]);
    }
  }
  brokers = [...brokers, ...(await get("AND phone_normalized IN ('" + DEMO_BROKERS.map((b) => "2" + b.phone).join("','") + "')"))];
  return { owner, manager, brokers };
}

async function seed(pool, agencyId) {
  // Nobody is messaged while the demo loads.
  require("../lib/notifications").notifyBroker = async () => ({ ok: true, skipped: true });
  const Store = require("../lib/listingStore");
  const Leads = require("../services/leads");
  const Deals = require("../services/deals");
  const Viewings = require("../services/viewings");
  const LeadRequests = require("../services/leadRequests");

  const { owner, manager, brokers } = await resolveActors(pool, agencyId);
  const actor = (who) => (who === "m" ? manager : who === "o" ? owner : brokers[who]);
  const out = { units: [], leads: [], deals: [], flags: 0, viewings: 0 };

  // ---- Units
  const byNo = new Map();
  for (const u of UNITS) {
    const broker = actor(u.who);
    const ev = Rules.evaluate(L.composeFields({ draft: draftOf(u), lang: "en" }), { lang: "en" });
    if (!ev.ok) throw new Error(`Unit ${u.n} is not valid: ${ev.blockers.map((b) => b.label_en).join(", ")}`);
    const res = await withTransaction(pool, (db) => Store.createListing(db, broker, { fields: ev.listing, code: null, lang: "en" }));
    if (!res.listing) throw new Error(`Unit ${u.n} was not created: ${JSON.stringify(res)}`);
    const listing = res.listing;
    byNo.set(u.n, listing);
    if (u.pin) await pool.query("UPDATE listings SET lat = $2, lng = $3 WHERE id = $1", [listing.id, u.pin[0], u.pin[1]]);
    if (u.private) await pool.query("UPDATE listings SET is_private = true WHERE id = $1", [listing.id]);
    if (u.archived) await pool.query("UPDATE listings SET status = 'archived' WHERE id = $1", [listing.id]);
    if (u.stale) await pool.query("UPDATE listings SET updated_at = now() - interval '22 days', confirmed_at = now() - interval '22 days', stale_asked_at = now() - interval '1 day' WHERE id = $1", [listing.id]);
    out.units.push(listing.code);
  }

  // ---- Leads
  const leadId = new Map();
  for (const l of LEADS) {
    const broker = actor(l.to === null ? "m" : l.to);
    const input = { phones: l.phone, name: l.name, kind: l.kind, source: l.source, note: l.note || null, assignTo: l.to === null ? null : broker.id };
    const res = await Leads.captureLead(pool, manager, input, { quiet: true });
    if (!res.lead) throw new Error(`Lead ${l.n} was not created: ${JSON.stringify(res).slice(0, 200)}`);
    const lead = res.lead;
    leadId.set(l.n, lead.id);
    const as = l.to === null ? manager : broker;
    if (l.stage && l.stage !== "new") {
      const r = await Leads.setStage(pool, as, lead.id, { stage: l.stage, lostReason: l.lost || null });
      if (r.error) throw new Error(`Lead ${l.n} stage: ${r.error}`);
    }
    if (l.private) await pool.query("UPDATE leads SET is_private = true WHERE id = $1", [lead.id]);
    if (l.request) {
      const r = await LeadRequests.saveRequest(pool, as, lead.id, l.request);
      if (r.error) throw new Error(`Lead ${l.n} request: ${r.error}`);
    }
    if (l.overdue) {
      const past = t(-3);
      await Leads.setFollowUp(pool, as, lead.id, { at: t(-1), kind: "call", note: "Call back about the budget", now: past });
    }
    if (l.viewing) {
      const unit = byNo.get(l.viewing.unit);
      const at = new Date(t(l.viewing.days).setHours(l.viewing.hour, 0, 0, 0));
      const r = await Viewings.schedule(pool, as, lead.id, { at, listing: unit, place: l.viewing.place });
      if (r.error) throw new Error(`Lead ${l.n} viewing: ${r.error}`);
      out.viewings++;
    }
    if (l.flag) {
      const r = await Leads.flagForManager(pool, as, lead.id, l.flag);
      if (r.error) throw new Error(`Lead ${l.n} flag: ${r.error}`);
      out.flags++;
      if (l.handled) {
        const h = await Leads.handleFlag(pool, manager, lead.id, l.handled);
        if (h.error) throw new Error(`Lead ${l.n} handled: ${h.error}`);
      }
    }
    out.leads.push(`L-${String(lead.ref).padStart(4, "0")}`);
  }

  // ---- Deals (a won deal moves the lead to won and marks the unit sold)
  for (const l of LEADS.filter((x) => x.deal)) {
    const unit = byNo.get(l.deal.unit);
    const as = l.to === null ? manager : actor(l.to);
    const r = await Deals.createDeal(pool, manager, {
      leadKey: leadId.get(l.n),
      unitCode: unit.code,
      price: Number(unit.price_value),
      mode: l.deal.mode,
      pct: l.deal.pct,
      amount: l.deal.amount,
      external: l.deal.external,
      dealType: l.deal.dealType,
      status: l.deal.status,
      closingBrokerId: as.id,
      markSold: l.deal.status !== "pending",
      notes: "Demo deal"
    }, { idemKey: `demo-${l.n}` });
    if (r.error) throw new Error(`Deal for lead ${l.n}: ${r.error}`);
    out.deals.push(`${unit.code}: ${l.deal.status}`);
  }
  return out;
}

async function main() {
  const { createPool } = require("../lib/db");
  const args = process.argv.slice(2);
  const cmd = args[0];
  const opt = (k, d = null) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
  const pool = createPool();
  try {
    let agencyId = opt("--agency");
    if (!agencyId) {
      const { rows } = await pool.query("SELECT a.id FROM agencies a JOIN brokers b ON b.agency_id = a.id AND b.phone_normalized = '201119998044' LIMIT 1");
      agencyId = rows[0]?.id;
    }
    if (!agencyId) throw new Error("Agency not found (pass --agency <id>).");
    if (["backup", "all"].includes(cmd)) console.log("backup", await backup(pool, opt("--out", "backup.json")));
    if (["clean", "all"].includes(cmd)) console.log("clean", await clean(pool, agencyId));
    if (["seed", "all"].includes(cmd)) console.log("seed", await seed(pool, agencyId));
    if (!["backup", "clean", "seed", "all"].includes(cmd)) console.log("Usage: seed-poc.js <backup|clean|seed|all> [--agency <id>] [--out <file>]");
  } finally {
    await pool.end();
  }
}

if (require.main === module) main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

module.exports = { backup, clean, seed, UNITS, LEADS };
