// web/views/credits.js — "What uses credits": the one table every agency sees (Plan page, My usage, landing), read from
// credit_actions so the owner's prices and the screens never disagree.
"use strict";

const { html } = require("../html");

const L = (lang, ar, en) => (lang === "en" ? en : ar);

const FREE_ACTIONS = [
  ["صفحة اتقرت قبل كده من أي وكالة، وفلاير تاني لنفس الوحدة", "A page any agency already read, and a later flyer for the same unit"],
  ["الإضافة والتعديل من الموقع، استيراد إكسل أو CSV، لينك العميل، فلاتر البحث", "Adding and editing on the website, Excel or CSV import, client links, search filters"],
  ["البحث بالكتابة لما الرصيد يخلص (بالمحلل المحلي)", "Typed search when credits run out (local parser)"]
];

/** The table of actions and their credits (actions = rows of credit_actions), plus what is always free. */
function creditTable(actions, lang) {
  const en = lang === "en";
  return html`<details class="card" data-credit-table>
  <summary>${L(lang, "إيه اللي بياخد رصيد؟", "What uses credits?")}</summary>
  <p class="muted">${L(lang, "كل عمل بالذكاء الاصطناعي بياخد رصيد، وبيتسجل في سجل الاستخدام ويشوفه المدير.", "Every AI action uses credits and is logged; managers can see the log.")}</p>
  <div class="scroll"><table><thead><tr><th>${L(lang, "العمل", "Action")}</th><th>${L(lang, "الرصيد", "Credits")}</th></tr></thead><tbody>
  ${actions.map((x) => html`<tr data-action="${x.action}"><td>${en ? x.label_en : x.label_ar}</td><td>${x.credits}</td></tr>`)}
  ${FREE_ACTIONS.map((x) => html`<tr data-free><td>${en ? x[1] : x[0]}</td><td>0</td></tr>`)}
  </tbody></table></div>
  <p class="muted">${L(lang, "لو الرصيد خلص: الإضافة والبحث بيفضلوا شغالين من الموقع؛ اللي بيقف هو الذكاء الاصطناعي لحد أول الشهر أو لحد ما تشتري رصيد زيادة.", "When credits run out, adding and searching still work on the website; only AI stops until next month or until you buy extra credits.")}</p>
</details>`;
}

module.exports = { creditTable };
