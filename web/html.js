// web/html.js — Server-side HTML: an escaping tagged template and the page layout (RTL by default)
"use strict";

const { BRAND } = require("../domain/brand");

class SafeHtml {
  constructor(text) {
    this.text = text;
  }
  toString() {
    return this.text;
  }
}

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;" };

/** Escapes text for HTML content and quoted attributes. */
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"'`]/g, (c) => ESC[c]);
}

function render(value) {
  if (value === null || value === undefined || value === false) return "";
  if (value instanceof SafeHtml) return value.text;
  if (Array.isArray(value)) return value.map(render).join("");
  return escapeHtml(value);
}

/** html`<p>${text}</p>`: every interpolated value is escaped unless it is already SafeHtml (or an array of it). */
function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return new SafeHtml(out);
}

/** Marks trusted markup (never use on user input). */
const raw = (text) => new SafeHtml(String(text ?? ""));

/** JSON text for an attribute; html`` escapes it once when interpolated. */
const jsonAttr = (obj) => JSON.stringify(obj);

const HTMX_CONFIG = { includeIndicatorStyles: false, allowEval: false, allowScriptTags: false, selfRequestsOnly: true, historyCacheSize: 0 };

/**
 * Full page. lang "ar" renders RTL; assets(name) gives the versioned static path.
 * @param {Object} p - { title, lang, body, assets, csrf, broker, nav, head, robots, unread }
 */
function layout({ title, lang = "ar", body, assets, csrf = null, broker = null, nav = null, head = null, robots = "noindex, nofollow", scripts = true, manifest = true, unread = 0, langSwitch = false, path = "", aiOff = [] }) {
  const en = lang === "en";
  const crm = Boolean(broker) && require("../lib/authz").isCrmOwner(broker);
  const tab = broker ? (crm ? crmTabOf(path) : tabOf(path, nav)) : null;
  return html`<!doctype html>
<html lang="${en ? "en" : "ar"}" dir="${en ? "ltr" : "rtl"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="${robots}">
<meta name="theme-color" content="${BRAND.colors.brand}">
<meta name="htmx-config" content="${jsonAttr(HTMX_CONFIG)}">
${csrf ? html`<meta name="csrf-token" content="${csrf}">` : ""}
<title>${title ? `${title} · WehdatHub` : "WehdatHub"}</title>
${manifest ? html`<link rel="manifest" href="/app/manifest.webmanifest">` : ""}
<link rel="icon" href="${assets(BRAND.logo)}" type="image/svg+xml">
<link rel="apple-touch-icon" href="${assets("icons/icon-192.png")}">
<link rel="stylesheet" href="${assets("brand.css")}">
<link rel="stylesheet" href="${assets("app.css")}">
${head || ""}
${scripts ? html`<script src="${assets("htmx.min.js")}" defer></script>
<script src="${assets("app.js")}" defer></script>
<script src="${assets("voice.js")}" defer></script>` : ""}
</head>
<body${broker ? raw(' class="has-tabbar"') : ""}${aiOff.length ? raw(` data-ai-off="${aiOff.join(",")}" data-ai-off-hint="${lang === "en" ? "Switched off by your agency owner" : "مقفول من مالك الشركة"}"`) : ""}>
${broker || nav || langSwitch ? topBar({ broker, nav, lang, unread, tab }) : ""}
<main id="main">${broker ? pageBar({ nav, lang, tab, path, crm }) : ""}${body}</main>
${broker ? footer(broker, lang) : ""}
${broker ? (crm ? crmTabBar(tab, lang) : tabBar(broker, tab, lang)) : ""}
${broker ? sideMenu(broker, tab, lang, { crm }) : ""}
<div class="toast" data-toast-box role="status" aria-live="polite" hidden></div>
</body>
</html>`;
}

// Where ← Back goes without history: a sub-page returns to its list, the rest to the home page.
const BACK = { search: "/app/search", units: "/app/units", leads: "/app/leads", deals: "/app/deals", catalogue: "/app/catalogue" };

/** Onboarding: the "?" tip of a main screen (3-4 steps, domain/onboarding.js). */
function screenTip(nav, lang) {
  const steps = require("../domain/onboarding").tip(nav, lang);
  if (!steps) return "";
  return html`<details class="tip" data-tip="${nav}"><summary aria-label="${lang === "en" ? "How this page works" : "إزاي الصفحة دي بتشتغل"}">${require("./icons").icon("help", 18)} ${lang === "en" ? "How it works" : "إزاي تستخدمها"}</summary><ol>${steps.map((s) => html`<li>${s}</li>`)}</ol></details>`;
}

/** One slim row above the page: Back on pages below a bottom-bar place, and the screen's "?" tip. */
function pageBar({ nav, lang, tab, path, crm = false }) {
  const en = lang === "en";
  // A bottom-bar place has no Back, except search results (Back returns to the search form).
  const [bare, query = ""] = String(path || "").split("?");
  const root = (crm ? CRM_ROOTS : TAB_ROOTS).has(bare.replace(/\/+$/, "") || "/app") && !(nav === "search" && /(^|&)(q|f)=/.test(query));
  const back = nav && !root ? html`<a class="backlink" data-back href="${BACK[nav] || "/app/"}">${require("./icons").icon("back", 18)} ${en ? "Back" : "رجوع"}</a>` : "";
  const tip = nav ? screenTip(nav, lang) : "";
  return back || tip ? html`<div class="pagebar">${back}${tip}</div>` : "";
}

function footer(broker, lang) {
  const en = lang === "en";
  const support = require("../services/onboarding").supportUrl(broker, lang);
  return html`<footer class="foot muted"><a href="/app/report">${en ? "Report a problem" : "بلّغ عن مشكلة"}</a>${support ? html` · <a href="${support}" target="_blank" rel="noopener" data-support>${en ? "Talk to a person" : "كلّم حد من فريقنا"}</a>` : ""}</footer>`;
}

// Every page a signed-in broker can open besides the bottom bar's places, grouped for the More page (/app/more).
// `who`: manager (Dashboard and other agency pages) or owner (App tracking, OWNER_BROKER_IDS only).
const NAV = [
  { key: "deals", href: "/app/deals", ar: "الصفقات", en: "Deals", icon: "deal", group: "work" },
  { key: "catalogue", href: "/app/catalogue", ar: "كتالوج المطورين", en: "Developer catalogue", icon: "catalogue", group: "work" },
  { key: "map", href: "/app/map", ar: "الخريطة", en: "Map", icon: "pin", group: "work" },
  { key: "ask", href: "/app/ask", ar: "اسأل المساعد", en: "Ask the assistant", icon: "chat", group: "work" },
  { key: "searches", href: "/app/searches", ar: "البحث المحفوظ", en: "Saved searches", icon: "star", group: "work" },
  { key: "requests", href: "/app/requests", ar: "طلبات العملاء", en: "Client requests", icon: "star", group: "work" },
  { key: "units", href: "/app/units", ar: "الوحدات", en: "Units", icon: "units", group: "work", barBroker: true },
  { key: "owners", href: "/app/owners", ar: "المُلّاك", en: "Owners", icon: "units", group: "work" },
  { key: "links", href: "/app/links", ar: "الروابط المفتوحة", en: "Opened links", icon: "pin", group: "work" },
  { key: "access", href: "/app/access-requests", ar: "طلبات البيانات الخاصة", en: "Private data requests", icon: "pin", group: "agency", who: "manager" },
  { key: "import", href: "/app/import", ar: "استيراد وحدات", en: "Import units", icon: "import", group: "work", desktop: true },
  { key: "leadimport", href: "/app/leads/import", ar: "استيراد عملاء", en: "Import leads", icon: "import", group: "work", desktop: true },
  { key: "dashboard", href: "/app/dashboard", ar: "لوحة الشركة", en: "Agency dashboard", icon: "chart", group: "agency", who: "manager" },
  { key: "sources", href: "/app/sources", ar: "مصادر العملاء وتكلفتها", en: "Lead sources and cost", icon: "chart", group: "agency", who: "manager" },
  { key: "winloss", href: "/app/winloss", ar: "المكسب والخسارة", en: "Win and loss", icon: "chart", group: "agency", who: "manager" },
  { key: "insights", href: "/app/insights", ar: "أسعار المتر", en: "Price per m²", icon: "chart", group: "agency" },
  { key: "usage", href: "/app/usage", ar: "استخدامي والحصص", en: "My usage and limits", icon: "gauge", group: "agency" },
  { key: "owner", href: "/app/owner", ar: "متابعة التطبيق", en: "App tracking", icon: "tools", group: "agency", who: "owner" },
  { key: "ownermap", href: "/app/owner/map", ar: "أماكن الخريطة", en: "Map places", icon: "pin", group: "agency", who: "owner" },
  { key: "ownerqueue", href: "/app/owner/queue", ar: "طابور الاعتماد", en: "Approval queue", icon: "tools", group: "agency", who: "owner" },
  { key: "ownerlibrary", href: "/app/owner/library", ar: "مكتبة المشاريع", en: "Project library", icon: "tools", group: "agency", who: "owner" },
  { key: "searchreview", href: "/app/owner/searches", ar: "مراجعة البحث", en: "Search review", icon: "tools", group: "agency", who: "owner" },
  { key: "plan", href: "/app/plan", ar: "الاشتراك", en: "Plan", icon: "card", group: "account" },
  { key: "invite", href: "/app/plan#referral", ar: "ادعُ شركة واكسب شهر مجاني", en: "Invite an agency, get a free month", icon: "gift", group: "account" },
  { key: "settings", href: "/app/settings", ar: "الإعدادات", en: "Settings", icon: "settings", group: "account" },
  { key: "notifications", href: "/app/notifications", ar: "التنبيهات", en: "Notifications", icon: "bell", group: "account" },
  { key: "guide", href: "/app/guide", ar: "الدليل", en: "Guide", icon: "book", group: "account" }
];

/** The More page links this broker sees (managers: the agency pages; the app owner: App tracking too). */
// Data entry sees only these More links (the pages it may open); everything else is hidden, not just refused.
const DATA_ENTRY_NAV = new Set(["notifications", "settings", "guide"]);
// Bar order for data entry: Search · Units · + · Owners · Settings (two places each side keep the + centred).
const DATA_ENTRY_TABS = ["search", "units", "add", "owners", "settings"];
const DATA_ENTRY_BAR = [
  { key: "search", href: "/app/search", ar: "بحث", en: "Search", icon: "search" },
  { key: "units", href: "/app/units", ar: "الوحدات", en: "Units", icon: "units" },
  { key: "add", href: "/app/units/new", ar: "إضافة", en: "Add", icon: "plus", fab: true },
  { key: "owners", href: "/app/owners", ar: "المُلّاك", en: "Owners", icon: "units" },
  { key: "settings", href: "/app/settings", ar: "الإعدادات", en: "Settings", icon: "settings" }
];

// The CRM owner (OWNER_BROKER_IDS) is not part of any agency: their menu is the app-tracking pages and their account.
const CRM_NAV = new Set(["owner", "ownermap", "ownerqueue", "ownerlibrary", "searchreview", "settings", "notifications", "guide"]);

function navFor(broker) {
  const Dash = require("../services/dashboards");
  if (require("../lib/authz").isCrmOwner(broker)) return NAV.filter((n) => CRM_NAV.has(n.key));
  if (require("../lib/authz").isDataEntry(broker)) return NAV.filter((n) => DATA_ENTRY_NAV.has(n.key));
  // What the bottom bar already shows is not repeated in More (a broker has Units on the bar; managers and team leads find it here).
  const onBar = new Set(tabsFor(broker).map((t) => t.href));
  return NAV.filter((n) => !n.who || (n.who === "manager" ? Dash.isManager(broker) : Dash.isOwner(broker))).filter((n) => !n.barBroker || !onBar.has(n.href));
}

// The bottom bar: five places. Brokers: Today · Search · + · Leads · Units; managers swap Units for Team.
// Units stays one tap away for managers under More, and inside Search as "My units".
const TABS = [
  { key: "home", href: "/app/", ar: "اليوم", en: "Today", icon: "home" },
  { key: "search", href: "/app/search", ar: "بحث", en: "Search", icon: "search" },
  { key: "add", href: "/app/add", ar: "إضافة", en: "Add", icon: "plus", fab: true },
  { key: "leads", href: "/app/leads", ar: "العملاء", en: "Leads", icon: "leads" },
  { key: "units", href: "/app/units", ar: "الوحدات", en: "Units", icon: "units", broker: true },
  { key: "team", href: "/app/team", ar: "الفريق", en: "Team", icon: "team", manager: true }
];
const TAB_ROOTS = new Set(["/app", "/app/search", "/app/add", "/app/leads", "/app/units", "/app/team", "/app/more"]);

/** Which bottom-bar place a page belongs to (by its path, else its nav key). */
function tabOf(path, nav) {
  const p = String(path || "").split("?")[0].replace(/\/+$/, "") || "/app";
  if (p === "/app") return "home";
  if (/^\/app\/(units\/new|leads\/new|deals\/new|add|import|leads\/import)(\/|$)/.test(p)) return "add";
  if (/^\/app\/(search|searches|ask|compare|map)(\/|$)/.test(p)) return "search";
  if (/^\/app\/leads(\/|$)/.test(p)) return "leads";
  if (/^\/app\/units(\/|$)/.test(p)) return "units";
  if (/^\/app\/team(\/|$)/.test(p)) return "team";
  if (/^\/app\/owners(\/|$)/.test(p)) return "owners";
  if (/^\/app\/settings(\/|$)/.test(p)) return "settings";
  return nav === "search" ? "search" : nav === "leads" ? "leads" : nav === "units" ? "units" : "more";
}

function tabBar(broker, tab, lang) {
  const en = lang === "en";
  const manager = require("../services/dashboards").isManager(broker);
  const { icon } = require("./icons");
  const dataEntry = require("../lib/authz").isDataEntry(broker);
  const tabs = tabsFor(broker);
  return html`<nav class="tabbar${dataEntry ? " de" : ""}" aria-label="${en ? "Main" : "القائمة الرئيسية"}">${tabs.map((t) =>
    t.fab
      ? html`<a class="fab" href="${t.href}" aria-label="${en ? t.en : t.ar}"${t.key === tab ? raw(' aria-current="page"') : ""}>${icon(t.icon, 28)}<span class="fab-label">${en ? t.en : t.ar}</span></a>`
      : html`<a href="${t.href}" data-tab="${t.key}"${t.key === tab ? raw(' aria-current="page"') : ""}>${icon(t.icon)}<span>${en ? t.en : t.ar}</span></a>`
  )}</nav>`;
}


/** The bottom-bar places this role sees (the same roles as the app's tabs): team leads get Team instead of Units. */
function tabsFor(broker) {
  const Authz = require("../lib/authz");
  if (Authz.isDataEntry(broker)) return DATA_ENTRY_BAR;
  const manager = require("../services/dashboards").isManager(broker);
  const lead = Authz.isTeamLead(broker);
  return TABS.filter((t) => (t.key === "units" ? !manager && !lead : t.key === "team" ? manager || lead : true));
}

/**
 * The laptop side menu: every place this role can open (its bottom-bar places, then the More pages), the same links the
 * More page lists, so the side menu and the phone never disagree. Hidden under 1024px (the bottom bar is used there).
 */
function sideMenu(broker, tab, lang, { crm = false } = {}) {
  const en = lang === "en";
  const { icon } = require("./icons");
  const bar = crm ? CRM_BAR : tabsFor(broker);
  const shown = new Set(bar.map((t) => t.href));
  const more = navFor(broker).filter((n) => !shown.has(n.href) && !n.desktopHidden);
  const GROUPS = [["work", "الشغل", "Work"], ["agency", "الشركة", "Agency"], ["account", "حسابي", "Account"]];
  const link = (n, current) => html`<a href="${n.href}"${current ? raw(' aria-current="page"') : ""}>${icon(n.icon, 20)}<span>${en ? n.en : n.ar}</span></a>`;
  return html`<nav class="sidemenu" aria-label="${en ? "Menu" : "القائمة"}">
  ${crm ? "" : html`<a class="side-add" href="${broker && require("../lib/authz").isDataEntry(broker) ? "/app/units/new" : "/app/add"}">${icon("plus", 20)}<span>${en ? "Add" : "إضافة"}</span></a>`}
  ${bar.filter((t) => !t.fab).map((t) => link(t, t.key === tab))}
  ${GROUPS.map(([g, ar, e]) => {
    const items = more.filter((n) => n.group === g);
    return items.length ? html`<div class="side-group">${en ? e : ar}</div>${items.map((n) => link(n, false))}` : "";
  })}
</nav>`;
}

// The CRM owner's own bottom bar: Home · Tracking · Board · Alerts · Settings.
const CRM_BAR = [
  { key: "home", href: "/app", ar: "الرئيسية", en: "Home", icon: "home" },
  { key: "owner", href: "/app/owner", ar: "المتابعة", en: "Tracking", icon: "chart" },
  { key: "board", href: "/app/owner/board", ar: "اللوحة", en: "Board", icon: "gauge" },
  { key: "alerts", href: "/app/notifications", ar: "التنبيهات", en: "Alerts", icon: "bell" },
  { key: "settings", href: "/app/settings", ar: "الإعدادات", en: "Settings", icon: "settings" }
];
const CRM_ROOTS = new Set(["/app", "/app/owner", "/app/owner/board", "/app/notifications", "/app/settings", "/app/more"]);

/** Which place of the CRM owner's bar a page belongs to. */
function crmTabOf(path) {
  const p = String(path || "").split("?")[0].replace(/\/+$/, "") || "/app";
  if (p === "/app") return "home";
  if (/^\/app\/owner\/board(\/|$)/.test(p)) return "board";
  if (/^\/app\/owner(\/|$)/.test(p)) return "owner";
  if (/^\/app\/notifications(\/|$)/.test(p)) return "alerts";
  if (/^\/app\/settings(\/|$)/.test(p)) return "settings";
  return "more";
}

function crmTabBar(tab, lang) {
  const en = lang === "en";
  const { icon } = require("./icons");
  return html`<nav class="tabbar crm" aria-label="${en ? "Main" : "القائمة الرئيسية"}">${CRM_BAR.map(
    (t) => html`<a href="${t.href}" data-tab="${t.key}"${t.key === tab ? raw(' aria-current="page"') : ""}>${icon(t.icon)}<span>${en ? t.en : t.ar}</span></a>`
  )}</nav>`;
}

function testRoleForm(broker, lang) {
  const en = lang === "en";
  const TestRole = require("../lib/testRole");
  const names = { owner: en ? "Owner" : "مالك", manager: en ? "Manager" : "مدير", team_lead: en ? "Team lead" : "قائد فريق", broker: en ? "Broker" : "بروكر", data_entry: en ? "Data entry" : "مدخل بيانات" };
  return html`<form method="post" action="/app/test-role" class="test-role" data-test-role><label><span class="sr-only">${en ? "Test role" : "دور التجربة"}</span><select name="role" data-autosubmit>${TestRole.ROLES.map((r) => html`<option value="${r}"${r === (broker.home_role || broker.role) ? raw(" selected") : ""}>${names[r]}</option>`)}</select></label><noscript><button type="submit">✓</button></noscript></form>`;
}

function viewAgencyForm(broker, lang) {
  const en = lang === "en";
  const on = Boolean(broker.view_of);
  return html`<form method="post" action="/app/test-view" class="test-role" data-test-role><label><span class="sr-only">${en ? "Agency" : "الشركة"}</span><select name="view" data-autosubmit><option value="home"${on ? "" : raw(" selected")}>${en ? "Test agency" : "شركة التجربة"}</option><option value="other"${on ? raw(" selected") : ""}>${en ? "NCH (read only)" : "NCH (للقراءة فقط)"}</option></select></label><noscript><button type="submit">✓</button></noscript></form>`;
}

function topBar({ broker, nav, lang, unread = 0, tab = null }) {
  const en = lang === "en";
  const { icon, MARK } = require("./icons");
  const TestRole = require("../lib/testRole");
  return html`<header class="top">
  <a class="brand" href="${broker ? "/app/" : "/"}" aria-label="${en ? "Wehdat Hub" : "وحدات هب"}">${MARK}${en ? html`<span dir="ltr">Wehdat <b>Hub</b></span>` : html`<span>وحدات <b>هب</b></span>`}</a>
  ${broker && TestRole.canSwitch(broker) && (TestRole.canView(broker) || broker.view_of) ? viewAgencyForm(broker, lang) : ""}
  ${broker && TestRole.canSwitch(broker) ? testRoleForm(broker, lang) : ""}
  ${broker
    ? html`<a class="iconbtn bell" href="/app/notifications" aria-label="${en ? "Notifications" : "التنبيهات"}"${nav === "notifications" ? raw(' aria-current="page"') : ""}>${icon("bell")}${unread ? html`<span class="badge" data-unread="${unread}">${unread > 99 ? "99+" : unread}</span>` : ""}</a>
  <a class="iconbtn" href="${tab === "more" ? "/app/" : "/app/more"}" aria-label="${tab === "more" ? (en ? "Close menu" : "إغلاق القائمة") : (en ? "More" : "المزيد")}"${tab === "more" ? raw(' aria-current="page" data-menu-close') : ""}>${icon("more")}</a>`
    : html`<a class="lang" data-lang-switch href="?lang=${en ? "ar" : "en"}" hreflang="${en ? "ar" : "en"}" lang="${en ? "ar" : "en"}">${en ? "عربي" : "English"}</a>`}
</header>`;
}

/**
 * Gives every POST form of a signed-in page the session's CSRF field (unless it already has one), so a plain
 * form submit passes verifyCsrf like htmx requests do. One field per form: a second would make `_csrf` an array.
 */
function withCsrf(pageHtml, csrf) {
  if (!csrf) return String(pageHtml);
  const field = `<input type="hidden" name="_csrf" value="${escapeHtml(csrf)}">`;
  return String(pageHtml).replace(/<form\b[^>]*\bmethod="post"[^>]*>[\s\S]*?<\/form>/gi, (form) =>
    form.includes('name="_csrf"') ? form : form.replace(">", `>${field}`)
  );
}

module.exports = { sideMenu, tabsFor, SafeHtml, html, raw, escapeHtml, jsonAttr, layout, withCsrf, NAV, navFor, TABS, tabOf, HTMX_CONFIG };
