// web/assets.js — Static files of the web app, held in memory with content hashes (no disk writes at runtime)
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const STATIC_DIR = path.join(__dirname, "static");
const TYPES = {
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json"
};

// Files served under /app/static/ (sw.js is served at /app/sw.js, filled in per version).
const FILES = {
  "app.css": path.join(STATIC_DIR, "app.css"),
  "app.js": path.join(STATIC_DIR, "app.js"),
  "voice.js": path.join(STATIC_DIR, "voice.js"),
  "htmx.min.js": require.resolve("htmx.org/dist/htmx.min.js"),
  "icons/icon.svg": path.join(STATIC_DIR, "icons", "icon.svg"),
  "icons/icon-192.png": path.join(STATIC_DIR, "icons", "icon-192.png"),
  "icons/icon-512.png": path.join(STATIC_DIR, "icons", "icon-512.png"),
  "icons/maskable-512.png": path.join(STATIC_DIR, "icons", "maskable-512.png")
};

const hash = (buf) => crypto.createHash("sha256").update(buf).digest("hex").slice(0, 10);

/** Loads every static file once: { files: name → { body, type, hash }, version, url(name), swSource }. */
function loadAssets() {
  const files = {};
  for (const [name, file] of Object.entries(FILES)) {
    if (!fs.existsSync(file)) continue;
    const body = fs.readFileSync(file);
    files[name] = { body, type: TYPES[path.extname(name)] || "application/octet-stream", hash: hash(body) };
  }
  const version = hash(Buffer.from(Object.values(files).map((f) => f.hash).join(".")));
  const url = (name) => {
    const f = files[name];
    if (!f) throw new Error(`Unknown static asset ${name}`);
    return `/app/static/${name}?v=${f.hash}`;
  };
  const swSource = fs
    .readFileSync(path.join(STATIC_DIR, "sw.js"), "utf8")
    .replace('"__VERSION__"', JSON.stringify(version))
    .replace("= __ASSETS__;", `= ${JSON.stringify(Object.keys(files).map(url))};`);
  return { files, version, url, swSource };
}

module.exports = { STATIC_DIR, FILES, loadAssets };
