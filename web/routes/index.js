// web/routes/index.js — Page modules of the web app, in mount order. Each exports register(router, ctx).
// PUBLIC pages are open (sign-in); PRIVATE pages need a signed-in broker and CSRF tokens on writes.
"use strict";

const PUBLIC = [require("./auth")];
const PRIVATE = [
  require("./home"),
  require("./search"),
  require("./imports"),
  require("./unitForm"),
  require("./units"),
  require("./notifications"),
  require("./settings"),
  require("./usage")
];

module.exports = { PUBLIC, PRIVATE };
