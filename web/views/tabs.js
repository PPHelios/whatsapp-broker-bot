// web/views/tabs.js — Radio tabs without script (up to six): a tab bar and one panel per tab. A #hash pointing into a
// panel opens it (web/static/app.js); `open` picks the tab shown first (a form's answer opens its own tab).
"use strict";

const { html } = require("../html");

/** panels: [[label, body], …]; name: the radio group (unique on the page). */
function tabs(name, panels, { open = 0, cls = "" } = {}) {
  const at = Math.min(Math.max(0, open), panels.length - 1);
  return html`<div class="tabs otabs${cls ? ` ${cls}` : ""}">
  ${panels.map((_, i) => html`<input type="radio" name="${name}" id="${name}-${i + 1}" class="tab-radio t${i + 1}"${i === at ? html` checked` : ""}>`)}
  <div class="tab-bar" role="tablist">${panels.map(([label], i) => html`<label for="${name}-${i + 1}" role="tab" class="l${i + 1}">${label}</label>`)}</div>
  ${panels.map(([, body], i) => html`<div class="tab-panel p${i + 1}" data-tab="${name}-${i + 1}">${body}</div>`)}
</div>`;
}

/** A switch between sibling pages (links, so each keeps its own URL): items [[href, label], …]. */
function seg(label, items, current) {
  return html`<nav class="seg" aria-label="${label}">${items.map(([href, text]) => html`<a href="${href}"${href === current ? html` aria-current="page"` : ""}>${text}</a>`)}</nav>`;
}

/** Deals and developer commissions are one place with two views. */
const dealsSwitch = (lang, current) =>
  seg(lang === "en" ? "Deals" : "الصفقات", [["/app/deals", lang === "en" ? "Deals" : "الصفقات"], ["/app/commissions", lang === "en" ? "Commissions" : "العمولات"]], current);

module.exports = { tabs, seg, dealsSwitch };
