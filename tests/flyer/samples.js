// tests/flyer/samples.js — The flyer sample set (plan step 7): deterministic inputs for renders and snapshots
"use strict";

const sharp = require("sharp");

const agency = { id: "a1", name: "Nile Homes", logo_url: "data:logo", primary_color: "#0B132B", secondary_color: "#D4AF37", phone: "0221111111" };
const broker = { id: "b1", name: "Mona Adel", phone_normalized: "201000000001" };
const NOW = "2026-10-24T10:00:00.000Z";

// Synthetic photos: colour gradients with simple shapes (no text, so no system fonts are involved).
async function photo(i, w = 1200, h = 800) {
  const hues = ["#5B8DB8", "#C9A66B", "#6E9E75", "#9C6B98", "#D98E5F", "#4F7A8C", "#B5B07A", "#7D8597", "#A65E5E"];
  const c = hues[i % hues.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c}"/><stop offset="1" stop-color="#1D2433"/></linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
    <rect x="${w * 0.15}" y="${h * 0.35}" width="${w * 0.5}" height="${h * 0.45}" fill="#F4F1EA" opacity="0.85"/>
    <polygon points="${w * 0.1},${h * 0.38} ${w * 0.4},${h * 0.12} ${w * 0.7},${h * 0.38}" fill="#3B3B3B" opacity="0.8"/>
    <circle cx="${w * 0.82}" cy="${h * 0.2}" r="${h * 0.09}" fill="#FFE8A3"/>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 85 }).toBuffer();
}

async function logo() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="160">
    <rect x="0" y="0" width="160" height="160" rx="32" fill="#D4AF37"/>
    <path d="M30 120 L80 40 L130 120 Z" fill="#0B132B"/>
    <rect x="190" y="40" width="260" height="28" rx="14" fill="#0B132B"/>
    <rect x="190" y="92" width="180" height="28" rx="14" fill="#5B6B8C"/>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

const base = { status: "active", confirmed_at: NOW, details: {}, feature_keys: [], features_other: [], payment_terms: {} };

const SAMPLES = [
  {
    name: "01-resale-cash",
    photos: 5,
    listing: { ...base, code: "APT-1", property_type: "apartment", listing_type: "sale", market: "resale", compound: "مدينتي", compound_en: "Madinaty",
      price_value: 8500000, area_value: 150, bedrooms: 3, bathrooms: 2, floor_level: 4, finishing: "fully_finished", is_ready: true,
      feature_keys: ["north_facing", "view_garden", "elevator"] }
  },
  {
    name: "02-resale-installments",
    photos: 4,
    listing: { ...base, code: "MV-7", property_type: "apartment", listing_type: "sale", market: "resale", compound: "ميفيدا", compound_en: "Mivida",
      price_value: 10000000, down_payment_value: 4000000, remaining_amount: 6000000, installment_value: 250000, payment_frequency: "quarterly",
      installments_end: "2032-10-01", area_value: 200, bedrooms: 3, bathrooms: 3, delivery_year: 2027, delivery_quarter: 3,
      feature_keys: ["corner", "nanny_room", "master_bedroom"], details: { over_price: 500000, club_fee: 150000 } }
  },
  {
    name: "03-primary-plans",
    photos: 6,
    listing: { ...base, code: "ZED-3", property_type: "apartment", listing_type: "sale", market: "primary", compound: "زد", compound_en: "ZED West",
      price_value: 11000000, area_value: 135, bedrooms: 2, bathrooms: 2, delivery_year: 2028, delivery_quarter: 2, maintenance_pct: 8,
      payment_terms: { cash_price: 9000000, plans: [{ plan_id: "p1", down_payment_pct: 10, years: 8, frequency: "quarterly" }, { plan_id: "p2", down_payment_pct: 5, years: 10, frequency: "monthly" }] },
      details: { project: "ZED West", developer: "Ora" } }
  },
  {
    name: "04-villa",
    photos: 9,
    listing: { ...base, code: "VIL-08", property_type: "villa", listing_type: "sale", market: "resale", compound: "بالم هيلز أكتوبر", compound_en: "Palm Hills October",
      price_value: 35000000, area_value: 400, bedrooms: 5, bathrooms: 6, finishing: "semi_finished", is_ready: true,
      feature_keys: ["north_facing", "private_garden", "private_pool", "nanny_room", "driver_room"], details: { land_area: 600, garden_area: 250, roof_area: 80 } }
  },
  {
    name: "05-studio",
    photos: 2,
    listing: { ...base, code: "STU-1", property_type: "studio", listing_type: "sale", market: "resale", compound: "الرحاب", compound_en: "Al Rehab",
      price_value: 1250000, area_value: 65, bedrooms: 0, bathrooms: 1, furnishing: "furnished", floor_level: 0 }
  },
  {
    name: "06-rent",
    photos: 3,
    theme: "light",
    listing: { ...base, code: "RNT-1", property_type: "apartment", listing_type: "rent", compound: "بيفرلي هيلز", compound_en: "Beverly Hills",
      price_value: 45000, area_value: 160, bedrooms: 3, bathrooms: 2, furnishing: "furnished", feature_keys: ["appliances", "ac_installed", "view_pool"] }
  },
  {
    name: "07-no-photos-no-logo",
    photos: 0,
    noLogo: true,
    listing: { ...base, code: "HP-201", property_type: "apartment", listing_type: "sale", market: "resale", compound: "Hyde Park",
      price_value: 9000000, area_value: 165, bedrooms: 3 }
  },
  {
    name: "08-long-arabic-name-many-features",
    photos: 7,
    listing: { ...base, code: "LNG-2026", property_type: "twinhouse", listing_type: "sale", market: "resale",
      compound: "كمبوند الياسمين الجديد بالقرب من محور الشيخ زايد والمطار الدولي", district: "الشيخ زايد", area_key: "sheikh_zayed",
      price_value: 27500000, area_value: 320, bedrooms: 4, bathrooms: 5, finishing: "ultra_super_lux", delivery_year: 2027,
      feature_keys: ["north_facing", "corner", "master_bedroom", "dressing_room", "nanny_room", "driver_room", "laundry_room", "roof", "private_garden",
        "view_landscape", "kitchen_installed", "ac_installed", "smart_home", "parking", "club_membership", "security"],
      features_other: ["جاكوزي", "Wine cellar"], details: { land_area: 450, title_en: "Exceptional Corner Twin House with Landscape View and Private Garden" } }
  }
];

async function sampleInputs(s) {
  const bufs = [];
  for (let i = 0; i < s.photos; i++) bufs.push(await photo(i));
  return { bufs, logoBuf: s.noLogo ? null : await logo(), agency: { ...agency, logo_url: s.noLogo ? null : agency.logo_url }, broker };
}

module.exports = { SAMPLES, sampleInputs, agency, broker };
