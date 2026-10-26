// web/routes/index.js — Page modules of the web app, in mount order. Each exports register(router, ctx).
// PUBLIC pages are open (sign-in); PRIVATE pages need a signed-in broker and CSRF tokens on writes.
"use strict";

const PUBLIC = [require("./auth"), require("./guide"), require("./signup"), require("./viewing")];
const PRIVATE = [
  require("./home"),
  require("./search"),
  require("./assistant"),
  require("./imports"),
  require("./unitForm"),
  require("./units"),
  require("./compare"),
  require("./leadImports"),
  require("./leads"),
  require("./deals"),
  require("./commissions"),
  require("./notifications"),
  require("./settings"),
  require("./usage"),
  require("./dashboard"),
  require("./team"),
  require("./plan"),
  require("./report"),
  require("./sources"),
  require("./insights"),
  require("./catalogueUpdates"),
  require("./brochure"),
  require("./catalogue"),
  require("./priceSheets")
];

module.exports = { PUBLIC, PRIVATE };
