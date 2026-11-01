// tests/unit/search-voice.test.js — the local search parser on real voice transcripts (the 13 recorded notes in the
// 2026-10-25 model eval, transcribed with the eval key and kept in fixtures/voice-transcripts.json). The notes describe
// units rather than searches, so each case checks what a search over the same words must read: the property type,
// the bedroom count and the area band where the note says them.
"use strict";

const fs = require("fs");
const path = require("path");
const Q = require("../../domain/searchQuery");

const NOTES = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "voice-transcripts.json"), "utf8"));
const transcriptOf = (file) => NOTES.find((n) => n.file.startsWith(file)).transcript;

const CASES = [
  { file: "01-", want: { property_types: ["apartment"], bedrooms_min: 3, bedrooms_max: null, area_min: 150, area_max: null } },
  { file: "02-", want: { property_types: ["apartment"], bedrooms_min: 3, bedrooms_max: null } },
  { file: "03-", want: { bedrooms_min: 3, bedrooms_max: null } }, // the note names no property type
  { file: "04-", want: { property_types: ["studio"] } },
  { file: "05-", want: { property_types: ["villa"], bedrooms_min: 5, bedrooms_max: null } },
  { file: "06-", want: { listing_type: "rent", property_types: ["apartment"], bedrooms_min: 3, bedrooms_max: null } },
  { file: "07-", want: { property_types: ["townhouse"], bedrooms_min: 4, bedrooms_max: null } },
  { file: "08a-", want: { property_types: ["duplex"] } },
  { file: "08b-", want: { bedrooms_min: 4, bedrooms_max: null } },
  { file: "09-", want: { property_types: ["apartment"], bedrooms_min: 2, bedrooms_max: null } },
  { file: "10-", want: { property_types: ["apartment"], bedrooms_min: 2, bedrooms_max: null } },
  { file: "11-", want: { property_types: ["apartment"] } },
  { file: "12-", want: { property_types: ["shop"] } },
  { file: "13-", want: { property_types: ["apartment"], bedrooms_min: 3, bedrooms_max: null } }
];

describe("local search parser on real voice transcripts", () => {
  test.each(CASES.map((c) => [c.file, c.want]))("%s", (file, want) => {
    const { filters } = Q.fallbackParse(transcriptOf(file));
    for (const [key, value] of Object.entries(want)) {
      if (Array.isArray(value)) expect(filters[key]).toEqual(expect.arrayContaining(value));
      else expect(filters[key]).toEqual(value);
    }
  });
});
