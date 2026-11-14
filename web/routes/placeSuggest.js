// web/routes/placeSuggest.js — The same suggestion list as the app (GET /app/places/suggest), for the website's place boxes.
"use strict";

const Suggest = require("../../services/placeSuggest");

function register(web, { pool }) {
  web.get("/places/suggest", async (req, res) => {
    res.set("Cache-Control", "no-store");
    return res.json({ items: await Suggest.suggest(pool, req.query.q, 8, req.session?.broker?.preferred_lang === "en" ? "en" : "ar") });
  });
}

module.exports = { register };
