// lib/flyerModel.js — Flyer data model (pure: no I/O, fully unit-tested; split out of lib/flyer.js).
"use strict";

const Describe = require("../domain/describe");
const Delivery = require("../domain/delivery");
const Rules = require("../domain/fieldRules");
const Places = require("../domain/places");
const { t } = require("./copy");
const { clean, en, truncate, titleCase, firstNum, firstText, trimNum, money, abbr, formatPhone } = require("./flyerStyle");

/* ====================================================================== */
/* 5. Data model (pure: no I/O, fully unit-tested)                          */
/* ====================================================================== */
/**
 * Flyer data model. Facts come from the single description template (domain/describe.js, English)
 * and the structured columns (delivery, features, resale schedule, plans). Never invents, never Arabic.
 */
function buildFlyerModel({
  listing,
  agency,
  broker,
  theme = "dark",
  unbranded = false
} = {}) {
  const L = listing || {};
  const D = L.details && typeof L.details === "object" ? L.details : {};
  const A = agency || {};
  const B = broker || {};
  const rent = L.listing_type === "rent";
  const pcase = Rules.paymentCase(L);
  const deal = pcase === "rent" ? "rent" : pcase === "primary" ? "primary" : pcase === "resale_installments" ? "resale" : "cash";
  const curr = (firstText(D.currency, L.currency) || "EGP").toUpperCase().slice(0, 4);
  const kind = Rules.unitKind(L.property_type);
  const isStudio = kind === "studio";
  const isVilla = kind === "villa";
  const isLand = kind === "land";
  const isCommercial = kind === "commercial";

  /* ---- type / tag ---- */
  const typeName = L.property_type ? Describe.typeLabel(L, "en") : null;
  const tagText = `${typeName ? typeName.toUpperCase() + " " : ""}FOR ${rent ? "RENT" : "SALE"}`;
  const badge = deal === "primary" ? "PRIMARY" : deal === "resale" ? "RESALE" : null;

  /* ---- place / title / location (English only) ---- */
  const areaName = L.area_key ? Places.placeName("area", L.area_key)?.en : null;
  const compound = en(firstText(L.compound_en, D.compound_en, L.compound));
  const district = en(L.district) || null;
  const city = en(L.city) || null;
  const place = compound || district || (areaName ? titleCase(areaName) : null) || city || en(L.location) || null;

  let title = en(firstText(D.title_en, L.title_en));
  if (title) title = clean(title.replace(/\s+for\s+(sale|rent)\b/gi, "")).replace(/[\s\-–,]+$/, "");
  if (!title || title.length < 6) title = typeName ? (place ? `${typeName} in ${place}` : typeName) : place || "Property";
  title = truncate(title, 64);
  const titleIsFallback = !en(firstText(D.title_en, L.title_en));
  const tl = title.toLowerCase();
  const seen = new Set();
  const locParts = [compound, district, areaName ? titleCase(areaName) : null, city].filter(Boolean).filter((x) => {
    const k = x.toLowerCase();
    if (seen.has(k) || tl.includes(k)) return false;
    seen.add(k);
    return true;
  });
  const locationLine = locParts.length ? truncate(locParts.join(", "), 52) : null;

  /* ---- numbers ---- */
  const price = firstNum(L.price_value);
  const area = firstNum(L.area_value);
  const land = firstNum(D.land_area);
  const garden = firstNum(D.garden_area);
  const roof = firstNum(D.roof_area);
  const beds = firstNum(L.bedrooms);
  const baths = firstNum(L.bathrooms, D.bathrooms);
  const delivery = Delivery.formatDelivery(L, "en", { icon: false });

  /* ---- price card ---- */
  const period = rent ? (String(D.rent_period || "").toLowerCase() === "yearly" ? "year" : "month") : null;
  const card = { kind: deal, missing: !price, label: null, main: null, unit: null, full: null, perSqm: null, right: null, notes: [] };
  card.label = { rent: "Rent", primary: "Price", resale: "Total price", cash: "Asking price" }[deal];
  if (!price) {
    card.main = "Price on request";
  } else if (rent) {
    card.main = money(price);
    card.unit = `${curr} / ${period}`;
  } else {
    card.main = abbr(price);
    card.unit = curr;
    if (price >= 1e4 && abbr(price) !== money(price)) card.full = `${money(price)} ${curr}`;
    if (area && price / area >= 1) card.perSqm = `~${abbr(price / area)} ${curr} / sqm`;
  }

  const fees = [
    firstNum(D.over_price) && `Over price ${abbr(firstNum(D.over_price))}`,
    firstNum(D.club_fee) && `Club fee ${abbr(firstNum(D.club_fee))}`,
    firstNum(D.transfer_fee) && `Transfer fee ${abbr(firstNum(D.transfer_fee))}`
  ].filter(Boolean);
  const maintenance = firstNum(D.maintenance_fee);
  const maintLine = maintenance
    ? `Maintenance deposit ${abbr(maintenance)}${D.maintenance_paid === true ? " (paid)" : D.maintenance_paid === false ? " (due on delivery)" : ""}`
    : null;

  if (deal === "primary") {
    const plans = (L.payment_terms?.plans || []).filter((p) => p && (p.down_payment_pct != null || p.years != null));
    const lines = plans.slice(0, 3).map((p) => Describe.planHint(p, "en").replace(/ · /g, " • "));
    const cash = firstNum(L.payment_terms?.cash_price);
    if (cash) lines.unshift(`Cash ${abbr(cash)}`);
    card.right = { type: "lines", lines, bold: delivery ? [delivery] : [] };
    const maint = Describe.maintenanceText(L, "en");
    card.notes.push(`Maintenance ${maint}`);
    if (maintLine) card.notes.push(maintLine);
  } else if (deal === "resale") {
    const paid = firstNum(L.down_payment_value);
    const rem = firstNum(L.remaining_amount);
    const each = firstNum(L.installment_value);
    const freq = Describe.frequencyLabel(L.payment_frequency, "en");
    const yrs = Describe.yearsLeft(L);
    if (paid) card.right = { type: "figure", label: "Cash required", value: abbr(paid) };
    const sched = [
      rem && `Remaining ${abbr(rem)}`,
      each && `${freq ? freq + " " : ""}installment ${abbr(each)}`,
      !each && freq && `${freq} installments`,
      yrs && yrs > 0 && `${trimNum(yrs, 1)} years left`
    ].filter(Boolean);
    if (sched.length) card.notes.push(sched.join(" • "));
    if (fees.length) card.notes.push(fees.join(" • "));
    if (maintLine) card.notes.push(maintLine);
  } else if (fees.length || maintLine) {
    if (fees.length) card.notes.push(fees.join(" • "));
    if (maintLine) card.notes.push(maintLine);
  }

  /* ---- facts (typology based, only stated values) ---- */
  const floor = Describe.floorLabel(L, "en");
  const finishing = Describe.finishingLabel(L, "en");
  const f = {
    area: area && { icon: "area", label: isLand ? "Land" : isVilla ? "BUA" : "Area", value: `${money(area)} sqm` },
    land: isVilla && land && { icon: "land", label: "Land", value: `${money(land)} sqm` },
    beds: !isStudio && !isLand && !isCommercial && beds && { icon: "bed", label: "Bedrooms", value: `${beds} Bed${beds > 1 ? "s" : ""}` },
    studio: isStudio && { icon: "bed", label: "Layout", value: "Studio" },
    baths: !isLand && baths && { icon: "bath", label: "Bathrooms", value: `${baths} Bath${baths > 1 ? "s" : ""}` },
    floor: !isVilla && !isLand && floor && { icon: "floor", label: "Floor", value: floor.replace(/^Floor /, "") },
    finishing: !isLand && finishing && { icon: "finishing", label: "Finishing", value: truncate(finishing, 24) },
    garden: garden && { icon: "garden", label: "Garden", value: `${money(garden)} sqm` },
    roof: roof && { icon: "roof", label: "Roof", value: `${money(roof)} sqm` }
  };
  const order = isLand
    ? ["area"]
    : isCommercial
    ? ["area", "floor", "finishing", "baths"]
    : isStudio
    ? ["area", "studio", "baths", "floor", "finishing", "garden"]
    : isVilla
    ? ["area", "land", "beds", "baths", "finishing", "garden", "roof"]
    : ["area", "beds", "baths", "floor", "finishing", "garden", "roof"];
  const allFacts = order.map((k) => f[k]).filter(Boolean);
  let facts = allFacts.slice(0, 6);
  // Every captured detail appears: facts beyond the 6-cell grid become chips.
  const overflowFacts = allFacts.slice(6).map((x) => ({ t: x.icon === "finishing" ? x.value : `${x.label} ${x.value}` }));

  /* ---- chips: delivery, features, furnishing (English labels from the dictionary) ---- */
  const chipSrc = [...overflowFacts];
  if (delivery && deal !== "primary") chipSrc.unshift({ t: delivery, hi: true });
  const furnishing = Describe.furnishingLabel(L, "en");
  if (furnishing) chipSrc.push({ t: furnishing });
  for (const label of Describe.featureLabels(L, "en")) chipSrc.push({ t: label });

  const key = (x) => String(x).toLowerCase().replace(/[^a-z0-9]/g, "");
  const used = new Set([key(tagText)]);
  const chips = [];
  for (const c of chipSrc) {
    const t = en(c.t);
    if (!t) continue;
    const k = key(t);
    if (!k || used.has(k)) continue;
    used.add(k);
    chips.push({ text: truncate(t, 22), hi: Boolean(c.hi) });
  }
  if (facts.length === 1 && !isLand) {
    chips.unshift({ text: `${facts[0].value} ${facts[0].label}`, hi: false });
    facts = [];
  }

  /* ---- contact / brand ---- */
  const co = Boolean(unbranded || L.is_unbranded);
  const agencyName = co ? null : en(firstText(A.name_en, A.name));
  const agentName = co ? null : en(firstText(B.name_en, B.name)) || agencyName;
  const phone = co ? null : formatPhone(B.contact_phone || B.phone_normalized || B.phone_number || A.contact_phone || A.phone);
  const code = String(L.code || "").toUpperCase().replace(/[^A-Z0-9-]/g, "");

  return {
    deal,
    theme,
    tag: { text: tagText, badge },
    title,
    titleIsFallback,
    locationLine,
    typeName,
    place,
    card,
    facts,
    chips,
    ref: code || null,
    brand: { name: agencyName || null, logoUrl: co ? null : A.logo_url || null },
    contact: {
      name: agentName ? truncate(agentName, 24) : null,
      phone,
      role: "Property Consultant",
      initial: ((agentName || "").match(/[A-Za-z]/) || [""])[0].toUpperCase()
    },
    colors: { primary: A.primary_color, secondary: A.secondary_color },
    unbranded: co
  };
}

module.exports = {
  buildFlyerModel
};
