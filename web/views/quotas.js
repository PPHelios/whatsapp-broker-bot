// web/views/quotas.js — The quota list as meters (manager dashboard, plan page).
"use strict";

const { html } = require("../html");

const L = (lang, ar, en) => (lang === "en" ? en : ar);
const num = (n) => Number(n).toLocaleString("en-US");

function quotaSection(items, lang) {
  return html`<section class="card" id="limits">
  <h2>🚦 ${L(lang, "الحدود والاستهلاك", "Limits and use")}</h2>
  <div class="grid">${items.map((q) => {
    const pct = q.limit > 0 ? Math.min(100, Math.round((q.used * 100) / q.limit)) : q.off ? 0 : 100;
    return html`<div class="card tile" data-quota="${q.key}"${q.off ? html` data-off` : ""}>
      <div class="muted"><a href="${q.href}">${q.label[lang === "en" ? 1 : 0]}</a></div>
      ${q.off ? html`<strong>${L(lang, "مقفول", "Off")}</strong>` : html`<strong>${num(q.used)} / ${num(q.limit)}</strong><progress max="100" value="${pct}">${pct}%</progress>`}
      <div class="muted">${q.hint[lang === "en" ? 1 : 0]}</div>
    </div>`;
  })}</div>
</section>`;
}

module.exports = { quotaSection };
