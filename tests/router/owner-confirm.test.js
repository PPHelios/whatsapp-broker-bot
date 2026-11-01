// tests/router/owner-confirm.test.js — Adding a unit by Telegram: a phone that matches an owner, or a new one, is shown on
// the review card and waits for a choice (link or create, or discard) before the unit can be saved.
"use strict";

jest.mock("../../lib/whatsapp", () => require("../harness/fake-whatsapp"));
jest.mock("../../lib/ai", () => require("../harness/fake-ai"));
jest.mock("../../lib/supabase", () => require("../harness/fake-supabase"));

const { createHarness, closeHarness, textOf } = require("../harness/app");

jest.setTimeout(90000);

let h;
beforeEach(async () => {
  h = await createHarness();
  h.AI.respond((c) =>
    c.operation === "listing_extraction"
      ? { listing_type: "sale", market: "resale", property_type: "apartment", compound: "Hyde Park", area_value: 150, bedrooms: 3, price_value: 8500000, delivery: {}, features: [], features_other: [], resale: {}, primary: {} }
      : null
  );
});
afterAll(closeHarness);

const contact = (who, name, phone) =>
  h.send(who, { type: "contacts", contacts: [{ name: { formatted_name: name }, phones: [{ phone, type: "CELL" }] }] });
const ids = (r) => (r.buttons || []).map((b) => b.id);
const ownerRow = async (phone) => (await h.query("SELECT * FROM unit_owners WHERE phones @> ARRAY[$1]::text[]", [phone]))[0];

// Opens a unit draft with the owner from a contact, then asks for the review card.
async function reviewWithOwner(name, phone) {
  await h.text("broker", "اضافة");
  await contact("broker", name, phone);
  await h.text("broker", "شقة هايد بارك 150 متر 3 غرف 8.5 مليون كود HP-77");
  return h.text("broker", "تم");
}

test("a new owner's phone waits for a choice; the unit is not saved until it is made", async () => {
  const card = await reviewWithOwner("Mr New", "01012345678");
  const text = textOf(card);
  expect(text).toMatch(/New owner|مالك جديد/);
  expect(ids(card[card.length - 1])).toContain("draft_owner_keep");
  expect(ids(card[card.length - 1])).not.toContain("draft_owner_drop");
  expect(ids(card[card.length - 1])).not.toContain("draft_confirm");
});

test("there is no discard: the owner is kept and the unit is saved with it", async () => {
  await reviewWithOwner("Mr New", "01012345678");
  await h.tap("broker", "draft_owner_keep");
  await h.tap("broker", "draft_confirm");
  const [l] = await h.query("SELECT owner_id, details FROM listings WHERE code = 'HP-77'");
  expect(l.owner_id).not.toBeNull();
  expect(l.details.owner_phone.replace(/\D/g, "")).toMatch(/1012345678$/);
});

test("a phone of an existing owner links the unit to that owner, not a new one", async () => {
  const [owner] = await h.query(
    "INSERT INTO unit_owners (agency_id, name, phones, created_by) VALUES ($1, 'Known Owner', ARRAY['201055550000']::text[], $2) RETURNING *",
    [h.AGENCY_A, h.BROKERS.broker.id]
  );
  const card = await reviewWithOwner("Known Owner", "01055550000");
  expect(textOf(card)).toMatch(/Existing owner|مالك موجود/);
  expect(ids(card[card.length - 1])).toContain("draft_owner_keep");
  await h.tap("broker", "draft_owner_keep");
  await h.tap("broker", "draft_confirm");
  const [l] = await h.query("SELECT owner_id FROM listings WHERE code = 'HP-77'");
  expect(l.owner_id).toBe(owner.id);
  expect((await h.query("SELECT count(*)::int AS n FROM unit_owners WHERE agency_id = $1", [h.AGENCY_A]))[0].n).toBe(1);
});
