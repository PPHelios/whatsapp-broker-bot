// tests/unit/authz-registry.test.js — lib/authz.js and the command registry matchers
"use strict";

const Authz = require("../../lib/authz");
const R = require("../../lib/registry");

test("canEdit: owner or manager role, same agency only", () => {
  const unit = { agency_id: "A", broker_id: "b1" };
  expect(Authz.canEdit({ id: "b1", agency_id: "A", role: "broker" }, unit)).toBe(true);
  expect(Authz.canEdit({ id: "b2", agency_id: "A", role: "broker" }, unit)).toBe(false);
  for (const role of ["admin", "owner", "manager"]) expect(Authz.canEdit({ id: "b2", agency_id: "A", role }, unit)).toBe(true);
  expect(Authz.canEdit({ id: "b1", agency_id: "B", role: "admin" }, unit)).toBe(false);
});

test("there is exactly one canEdit implementation", () => {
  const fs = require("fs");
  const path = require("path");
  const root = path.join(__dirname, "..", "..");
  const files = [...fs.readdirSync(path.join(root, "routes")).map((f) => `routes/${f}`), ...fs.readdirSync(path.join(root, "lib")).map((f) => `lib/${f}`)];
  const defs = files.filter((f) => f.endsWith(".js") && /function canEdit\s*\(/.test(fs.readFileSync(path.join(root, f), "utf8")));
  expect(defs).toEqual(["lib/authz.js"]);
});

test.each([
  ["اتباعت VIL-08", "status", { action: "sold", code: "VIL-08" }],
  ["VIL-08 اتباعت", "status", { action: "sold", code: "VIL-08" }],
  ["أرشفة HP-201", "status", { action: "archive", code: "HP-201" }],
  ["لسه متاحة HP-201", "status", { action: "available", code: "HP-201" }],
  ["سعر HP-201 9 مليون", "price", { code: "HP-201", priceText: "9 مليون" }],
  ["تعديل سعر HP-201 إلى 9 مليون", "price", { code: "HP-201", priceText: "9 مليون" }],
  ["تعديل HP-201 السعر 9 مليون", "edit", { code: "HP-201", instructions: "السعر 9 مليون" }],
  ["تعديل HP-201", "edit", { code: "HP-201", instructions: null }]
])("%s → %s", (text, name, args) => {
  const hit = R.find(text, {});
  expect(hit.command.name).toBe(name);
  expect(hit.args).toEqual(args);
});

test("sentences that only contain a keyword are not commands", () => {
  for (const t of ["شقة متاحة في التجمع", "عايز فيلا اتباعت قريب", "السعر كام"]) expect(R.find(t, {})).toBeNull();
});

test("'تم' and 'المزيد' are commands only when their session is open", () => {
  expect(R.find("تم", {})).toBeNull();
  expect(R.find("تم", { editOpen: true }).command.name).toBe("edit_done");
  expect(R.find("المزيد", {})).toBeNull();
  expect(R.find("المزيد", { searchOpen: true }).command.name).toBe("more");
});

test("voice only triggers quick updates", () => {
  expect(R.find("تعديل HP-201", {}, { voice: true })).toBeNull();
  expect(R.find("اتباعت HP-201", {}, { voice: true }).command.name).toBe("status");
});
