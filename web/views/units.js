// web/views/units.js — Unit fragments for the web, built from domain/describe.js (the one template)
"use strict";

const Describe = require("../../domain/describe");
const { html } = require("../html");

const stripMarkdown = (s) => String(s || "").replace(/[*`_]/g, "");

/** Search result: the compact line (code as a link) and every feature as a tag. */
function resultItem(l, lang = "ar", { selectable = false } = {}) {
  const line = stripMarkdown(Describe.compactLine(l, lang).replace(/^`[^`]*`\s*·\s*/, ""));
  const tags = Describe.featureLabels(l, lang);
  return html`<li class="card result" data-code="${l.code}">
  <div class="line">${selectable ? html`<input type="checkbox" name="code" value="${l.code}" form="bulk" aria-label="${l.code}"> ` : ""}<a href="/app/units/${encodeURIComponent(l.code)}">${l.code}</a> · ${line}</div>
  ${tags.length ? html`<ul class="tags">${tags.map((t) => html`<li>${t}</li>`)}</ul>` : ""}
</li>`;
}

/** Every fact (and, for brokers, the internal lines) as a list. */
function factList(l, lang = "ar", { internal = true } = {}) {
  const lines = [...Describe.factLines(l, lang), ...(internal ? Describe.internalLines(l, lang) : [])].map(stripMarkdown);
  return html`<ul class="facts">${lines.map((x) => html`<li>${x}</li>`)}</ul>`;
}

module.exports = { stripMarkdown, resultItem, factList };
