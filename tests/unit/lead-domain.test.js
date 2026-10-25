// tests/unit/lead-domain.test.js — domain/leadStages.js, domain/leadCard.js and the lead/deal rules in lib/authz.js
"use strict";

const Stages = require("../../domain/leadStages");
const Card = require("../../domain/leadCard");
const Authz = require("../../lib/authz");

test("stages: any stage is allowed; lost needs a reason", () => {
  expect(Stages.STAGES).toEqual(["new", "contacted", "interested", "viewing", "negotiation", "won", "lost"]);
  for (const s of Stages.STAGES.filter((x) => x !== "lost")) expect(Stages.stageError(s)).toBeNull();
  expect(Stages.stageError("lost")).toBe("lost_reason_required");
  expect(Stages.stageError("lost", "  ")).toBe("lost_reason_required");
  expect(Stages.stageError("lost", "x".repeat(201))).toBe("lost_reason_too_long");
  expect(Stages.stageError("lost", "bought elsewhere")).toBeNull();
  expect(Stages.stageError("closed")).toBe("unknown_stage");
  expect(Stages.stageAfterContact("new")).toBe("contacted");
  expect(Stages.stageAfterContact("viewing")).toBe("viewing");
  expect(Stages.isClosed("won") && Stages.isClosed("lost") && !Stages.isClosed("negotiation")).toBe(true);
});

test("labels exist in both languages for every stage, kind and lawful basis", () => {
  for (const s of Stages.STAGES) expect(Stages.stageLabel(s, "ar")).not.toBe(Stages.stageLabel(s, "en"));
  for (const k of Stages.KINDS) expect(Stages.kindLabel(k, "ar")).not.toBe(Stages.kindLabel(k, "en"));
  for (const b of Stages.LAWFUL_BASES) expect(Stages.basisLabel(b, "ar")).not.toBe(Stages.basisLabel(b, "en"));
});

test("references: L-0042 both ways, Arabic letter and digits too", () => {
  expect(Card.refLabel(42)).toBe("L-0042");
  expect(Card.refLabel(12345)).toBe("L-12345");
  for (const t of ["L-0042", "l-42", "L42", "#L-42", "ل-٤٢", "L - 42"]) expect(Card.parseRef(t)).toBe(42);
  for (const t of ["", "VIL-08", "L-", "42", "L-0"]) expect(Card.parseRef(t)).toBeNull();
});

const lead = (over = {}) => ({
  id: "x",
  ref: 7,
  agency_id: "A",
  name: null,
  phone_e164: "+201012345678",
  phones: ["+201012345678", "+20225551234"],
  kind: "buyer",
  stage: "new",
  assigned_broker_id: "b1",
  follow_up_status: null,
  ...over
});

test("no name: 'Client ••5678', never invented", () => {
  expect(Card.displayName(lead(), "en")).toBe("Client ••5678");
  expect(Card.displayName(lead(), "ar")).toBe("عميل ••5678");
  expect(Card.displayName(lead({ name: " Sara " }), "en")).toBe("Sara");
  expect(Card.listLine(lead({ name: "Sara" }), "en")).toBe("L-0007 · Sara · 🆕 New");
});

test("the card: every number, stage, next step, notes; lost shows the reason", () => {
  const en = Card.card(lead({ notes: "prefers ground floor" }), { lang: "en", assigneeName: "Omar" });
  expect(en).toContain("Client ••5678 · L-0007");
  expect(en).toContain("0101 234 5678 · 02 2555 1234");
  expect(en).toContain("No next step");
  expect(en).toContain("With: Omar");
  expect(en).toContain("📝 prefers ground floor");
  const lost = Card.card(lead({ stage: "lost", lost_reason: "bought elsewhere" }), { lang: "en" });
  expect(lost).toContain("Lost (bought elsewhere)");
  expect(lost).not.toContain("No next step");
  const fu = Card.card(lead({ follow_up_status: "open", follow_up_kind: "viewing", next_follow_up_at: new Date("2026-11-01T15:00:00Z") }), { lang: "ar" });
  expect(fu).toContain("معاينة: 2026-11-01 15:00");
  expect(Card.card(lead({ assigned_broker_id: null }), { lang: "en" })).toContain("Unassigned");
});

test("timeline lines in both languages; undone events are marked", () => {
  const at = new Date("2026-10-25T10:00:00Z");
  expect(Card.timelineLine({ kind: "stage", data: { to: "viewing" }, created_at: at, broker_name: "Omar" }, "en")).toBe("2026-10-25 10:00 ➡️ 🏠 Viewing · Omar");
  expect(Card.timelineLine({ kind: "contacted", data: {}, created_at: at, undone_at: at }, "en")).toContain("(undone)");
  expect(Card.timelineLine({ kind: "assigned", data: { to: null }, created_at: at }, "ar")).toContain("رجع للمجموعة");
  expect(Card.timelineLine({ kind: "inquiry", data: { colleague: true }, created_at: at }, "en")).toContain("colleague");
});

test("Q1 lead visibility: assigned broker or a manager, same agency only; unassigned = managers", () => {
  const broker = { id: "b1", agency_id: "A", role: "broker" };
  const other = { id: "b2", agency_id: "A", role: "broker" };
  const manager = { id: "m1", agency_id: "A", role: "Manager" };
  const rival = { id: "r1", agency_id: "B", role: "admin" };
  expect(Authz.canViewLead(broker, lead())).toBe(true);
  expect(Authz.canViewLead(other, lead())).toBe(false);
  expect(Authz.canViewLead(manager, lead())).toBe(true);
  expect(Authz.canViewLead(rival, lead())).toBe(false);
  expect(Authz.canViewLead(broker, lead({ assigned_broker_id: null }))).toBe(false);
  expect(Authz.canViewLead(manager, lead({ assigned_broker_id: null }))).toBe(true);
  expect(Authz.canEditLead(other, lead())).toBe(false);
  expect(Authz.canManageLeads(broker)).toBe(false);
  expect(Authz.canManageLeads(manager)).toBe(true);
});

test("Q10 deal visibility: closing broker, a share holder or a manager; editing: closer or manager", () => {
  const deal = { agency_id: "A", closing_broker_id: "b1", shares: [{ broker_id: "b2" }] };
  expect(Authz.canViewDeal({ id: "b2", agency_id: "A", role: "broker" }, deal)).toBe(true);
  expect(Authz.canViewDeal({ id: "b3", agency_id: "A", role: "broker" }, deal)).toBe(false);
  expect(Authz.canEditDeal({ id: "b2", agency_id: "A", role: "broker" }, deal)).toBe(false);
  expect(Authz.canEditDeal({ id: "b1", agency_id: "A", role: "broker" }, deal)).toBe(true);
  expect(Authz.canEditDeal({ id: "m", agency_id: "A", role: "owner" }, deal)).toBe(true);
  expect(Authz.canViewDeal({ id: "m", agency_id: "B", role: "owner" }, deal)).toBe(false);
});

const Intake = require("../../domain/leadIntake");

test.each([
  ["كلمني 0101 234 5678 او 01112345678", ["+201012345678", "+201112345678"]],
  ["+20 101 234 5678", ["+201012345678"]],
  ["رقمه ٠١٠١٢٣٤٥٦٧٨", ["+201012345678"]],
  ["تليفون (02) 2555-1234", ["+20225551234"]],
  ["0020-101-234-5678", ["+201012345678"]],
  ["+1 415 555 0100", ["+14155550100"]],
  ["مقدم 500000 قسط 25000 سعر 8500000 مساحة 150", []],
  ["تسليم 2027 الدور 3", []]
])("findPhones(%s)", (text, out) => {
  expect(Intake.findPhones(text)).toEqual(out);
});

test("contact cards: every number, invalid ones counted; wa_id preferred", () => {
  const [c] = Intake.parseContactCard([{ name: { formatted_name: "Sara" }, phones: [{ phone: "0101 234 5678" }, { phone: "x" }, { wa_id: "201112345678", phone: "ignored" }] }]);
  expect(c).toEqual({ name: "Sara", phones: ["+201012345678", "+201112345678"], invalid: 1 });
});

test("looksLikeLead: a phone and no unit; bare phones", () => {
  expect(Intake.looksLikeLead("انا احمد رقمي 01012345678 عايز شقة")).toBe(true);
  expect(Intake.looksLikeLead("شقة 150م 3 غرف بسعر 8.5 مليون 01012345678 كود HP-201")).toBe(false);
  expect(Intake.looksLikeLead("للبيع شقة 150 متر 3 غرف السعر 8,500,000 تواصل 01012345678")).toBe(false);
  expect(Intake.looksLikeLead("عايز شقة في التجمع")).toBe(false);
  expect(Intake.isBarePhone("0101 234 5678")).toBe(true);
  expect(Intake.isBarePhone("01012345678 hi")).toBe(false);
});

// Q13: every CRM command has an English form.
test.each([
  ["ليد", "lead"],
  ["عميل جديد", "new lead"],
  ["عملائي", "my leads"],
  ["متابعات", "followups"],
  ["حول L-0042 لـ سارة", "assign L-0042 to Sara"],
  ["L-0042", "L-0042"]
])("%s ↔ %s", (ar, en) => {
  const kind = (t) =>
    Intake.matchLeadCommand(t) ? "lead" : Intake.matchMyLeads(t) ? "my" : Intake.matchFollowUps(t) ? "fu" : Intake.matchAssign(t) ? "assign" : Intake.matchRef(t) ? "ref" : null;
  expect(kind(ar)).not.toBeNull();
  expect(kind(ar)).toBe(kind(en));
});

test("«عميل CODE» (client copy) and leads/lead are told apart", () => {
  expect(Intake.matchLeadCommand("عميل HP-201")).toBeNull();
  expect(Intake.matchLeadCommand("leads")).toBeNull();
  expect(Intake.matchLeadCommand("ليد: احمد 0101")).toEqual({ rest: "احمد 0101" });
});

test("the extraction never fills what the AI left empty", () => {
  expect(Intake.normalizeLeadExtraction({ name: "null", phones: [], kind: "investor", request: {} })).toEqual({ name: null, phones: [], kind: null, source: null, note: null, request: null });
  const r = Intake.normalizeLeadExtraction({ name: " Ahmed ", phones: ["0101"], kind: "tenant", request: { listing_type: "rent", price_max: 25000 } });
  expect(r).toMatchObject({ name: "Ahmed", phones: ["0101"], kind: "tenant" });
  expect(r.request).toMatchObject({ listing_type: "rent", price_max: 25000 });
  expect(Intake.buildLeadPrompt("ar", "ABCD1234")).toContain("===ABCD1234===");
});

test("cairoDayAt: 10:00 Cairo N days ahead, across summer time", () => {
  expect(Stages.cairoDayAt(new Date("2026-10-25T21:30:00Z"), 1, 10).toISOString()).toBe("2026-10-27T07:00:00.000Z");
  expect(Stages.cairoDayAt(new Date("2026-12-31T23:00:00Z"), 1, 10).toISOString()).toBe("2027-01-02T08:00:00.000Z");
});

test("request summary in both languages", () => {
  const f = { listing_type: "sale", property_types: ["villa"], places: [{ kind: "area", key: "new_cairo" }], price_max: 9000000, bedrooms_min: 3, bedrooms_max: 3 };
  expect(Card.requestSummary(f, "en")).toBe("Villa · sale · New Cairo · up to 9M EGP · 3 bedrooms");
  expect(Card.requestSummary(f, "ar")).toContain("التجمع الخامس");
});
