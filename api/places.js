// api/places.js — One suggestion list for place boxes in the app: compounds, aliases, areas and sub-zones together.
"use strict";

const Suggest = require("../services/placeSuggest");

function register(api, { pool }) {
  // GET /places/suggest?q=… → { items: [{ kind: "compound"|"area"|"subzone", id, name_en, name_ar, path, via }] }
  api.get("/places/suggest", async (req, res) => {
    const items = await Suggest.suggest(pool, req.query.q, Number(req.query.limit) || 8, req.query.lang === "ar" ? "ar" : "en");
    return res.json({ items });
  });

  // GET /places/list[?since=<version>] → { version, places, areas } or { version, unchanged: true }.
  // The app keeps this list and matches typing on the phone (same rules as /places/suggest, see domain/areas.js).
  api.get("/places/list", async (req, res) => {
    return res.json(await Suggest.listing(pool, String(req.query.since || "").slice(0, 40)));
  });
}

module.exports = { register };
