// web/views/quotas.js — The quota list as meters (manager dashboard, plan page).
"use strict";

const { html } = require("../html");

const L = (lang, ar, en) => (lang === "en" ? en : ar);
const num = (n) => Number(n).toLocaleString("en-US");

function quotaSection(items, lang) {
  return html`<section class="card" id="limits">
  <h2>${L(lang, "الحدود والاستهلاك", "Limits and use")}</h2>
  <ul class="quotas">${items.map((q) => {
    const pct = q.limit > 0 ? Math.min(100, Math.round((q.used * 100) / q.limit)) : q.off ? 0 : 100;
    return html`<li data-quota="${q.key}"${q.off ? html` data-off` : ""}${pct >= 80 && !q.off ? html` class="high"` : ""}>
      <details><summary><a href="${q.href}">${q.label[lang === "en" ? 1 : 0]}</a>${q.off ? html`<strong class="muted">${L(lang, "مقفول", "Off")}</strong>` : html`<strong>${num(q.used)} / ${num(q.limit)}</strong>`}${q.off ? "" : html`<progress max="100" value="${pct}">${pct}%</progress>`}</summary>
      <p class="muted small">${q.hint[lang === "en" ? 1 : 0]}</p></details>
    </li>`;
  })}</ul>
</section>`;
}

module.exports = { quotaSection };
