// tests/unit/docs.test.js — The operator docs keep up with the code: every env var the code reads is in
// the runbook, every migration is in the manifest, the broker guides exist.
"use strict";

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");

function sources(dir) {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (e.name === "static" ? [] : sources(`${dir}/${e.name}`)) : e.name.endsWith(".js") ? [`${dir}/${e.name}`] : []
  );
}

test("docs/runbook.md lists every environment variable the service reads", () => {
  const files = [...["lib", "routes", "services", "web", "domain"].flatMap(sources), "server.js", "config.js"];
  const vars = new Set();
  for (const f of files) {
    for (const m of read(f).matchAll(/(?:process\.env|\benv)\.([A-Z][A-Z0-9_]+)/g)) vars.add(m[1]);
  }
  const runbook = read("docs/runbook.md");
  const missing = [...vars].filter((v) => !runbook.includes(`\`${v}\``));
  expect(missing).toEqual([]);
  expect(vars.size).toBeGreaterThan(15);
});

test("ARCHITECTURE_MANIFEST.md names every migration", () => {
  const manifest = read("ARCHITECTURE_MANIFEST.md");
  const missing = fs.readdirSync(path.join(root, "db", "migrations")).filter((f) => !manifest.includes(f));
  expect(missing).toEqual([]);
});

test("the broker guides and the runbook exist and point at each other", () => {
  expect(read("docs/pilot/broker-howto-ar.md")).toMatch(/دليل الموقع/);
  expect(read("docs/pilot/web-howto-ar.md")).toMatch(/\*دخول\*/);
  expect(read("docs/pilot/broker-howto-en.md")).toMatch(/web-howto-en\.md/);
  expect(read("docs/pilot/web-howto-en.md")).toMatch(/\*login\*/);
  for (const lang of ["ar", "en"]) {
    const crm = read(`docs/pilot/crm-howto-${lang}.md`);
    for (const s of ["L-0042", "VIL-08", "iOS 16.4", "| --- |"]) expect([lang, s, crm.includes(s)]).toEqual([lang, s, true]);
    expect(read(`docs/pilot/broker-howto-${lang}.md`)).toContain(`crm-howto-${lang}.md`);
    expect(read(`docs/pilot/web-howto-${lang}.md`)).toContain(`crm-howto-${lang}.md`);
  }
  const runbook = read("docs/runbook.md");
  for (const s of ["agency_outbound_daily", "operation_logs", "npm run migrate", "npm run onboard", "render.yaml", "Rotating secrets", "web-howto-ar.md", "broker-howto-en.md", "start link"]) {
    expect([s, runbook.includes(s)]).toEqual([s, true]);
  }
});
