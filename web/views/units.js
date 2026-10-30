// web/views/units.js — Unit fragments for the web, built from domain/describe.js (the one template)
"use strict";

const Describe = require("../../domain/describe");
const { html } = require("../html");
const Delivery = require("../../domain/delivery");

const stripMarkdown = (s) => String(s || "").replace(/[*`_]/g, "");

/** A unit card (search results, My units): code and price first, then size, payment and delivery as chips, and the
 * features on a copper strip. `selectable` adds a tick box for the bulk bar. */
function resultItem(l, lang = "ar", { selectable = false, ask = null, back = "" } = {}) {
  const en = lang === "en";
  const loc = en ? l.compound_en || l.details?.compound_en || l.compound || l.district : l.compound || l.compound_en || l.district;
  const size = [Describe.areaLabel(l, lang), Describe.bedsLabel(l, lang), Describe.bathsLabel(l, lang)].filter(Boolean).join(" · ");
  const delivery = Delivery.formatDelivery(l, lang);
  const pay = Describe.paymentHint(l, lang);
  const tags = Describe.featureLabels(l, lang);
  const href = `/app/units/${encodeURIComponent(l.code)}`;
  return html`<li class="card result unitcard" data-code="${l.code}">
  ${selectable ? html`<input class="pick" type="checkbox" name="code" value="${l.code}" form="bulk" aria-label="${l.code}">` : ""}
  <a class="uc-main" href="${href}">
    <span class="uc-top"><b class="code" dir="ltr">${l.code}</b><b class="uc-price">${stripMarkdown(Describe.priceLabel(l, lang) || "")}</b></span>
    <span class="uc-sub">${[Describe.typeLabel(l, lang), loc].filter(Boolean).join(" · ")}</span>
    ${size ? html`<span class="uc-size">${stripMarkdown(size)}</span>` : ""}
  </a>
  ${pay || delivery ? html`<ul class="tags">${pay ? html`<li>${stripMarkdown(pay)}</li>` : ""}${delivery ? html`<li class="chip good">${stripMarkdown(delivery)}</li>` : ""}</ul>` : ""}
  ${tags.length ? html`<ul class="uc-feat">${tags.map((t) => html`<li>${t}</li>`)}</ul>` : ""}
  ${ask === "ask"
    ? html`<form method="post" action="${href}/access" class="row"><input type="hidden" name="back" value="${back}"><button type="submit" class="secondary small" data-ask-details>🔒 ${en ? "Ask for private details" : "اطلب البيانات الخاصة"}</button></form>`
    : ask === "pending"
      ? html`<p class="muted small" data-ask-pending>🔒 ${en ? "Requested. A manager will answer." : "اتطلبت. المدير هيرد."}</p>`
      : ""}
</li>`;
}

/** Every fact (and, for brokers, the internal lines) as a list. */
function factList(l, lang = "ar", { internal = true } = {}) {
  const lines = [...Describe.factLines(l, lang), ...(internal ? Describe.internalLines(l, lang) : [])].map(stripMarkdown);
  return html`<ul class="facts">${lines.map((x) => html`<li>${x}</li>`)}</ul>`;
}

module.exports = { stripMarkdown, resultItem, factList };
