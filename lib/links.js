// lib/links.js — Every absolute link the app sends out (WhatsApp messages, OG tags, emails) is built here,
// from PUBLIC_BASE_URL through config.publicUrl. Pages inside the site use relative paths.
"use strict";

const { publicUrl } = require("../config");

const enc = encodeURIComponent;

function withQuery(path, query = {}) {
  const qs = Object.entries(query)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `${enc(k)}=${enc(v)}`)
    .join("&");
  return qs ? `${path}?${qs}` : path;
}

/** Origin of the site (scheme + host), e.g. for same-origin checks. */
function siteOrigin() {
  return new URL(publicUrl("/")).origin;
}

/** Absolute URL of a page in the broker web app (/app/...). */
function appUrl(path = "/", query = {}) {
  const p = String(path || "/").replace(/^\/+/, "");
  return publicUrl(withQuery(`/app/${p}`, query));
}

/** Magic-link login: opens a confirm page (GET), which signs in with a POST. */
function loginLinkUrl(token) {
  return appUrl("login/confirm", { t: token });
}

/** Web search with filters already applied ("refine and see all" from WhatsApp). */
function searchUrl(encodedFilters) {
  return appUrl("search", { f: encodedFilters });
}

/** Short redirect to a stored wa.me link ("📤 Send on WhatsApp" from Telegram when the link is too long). */
function waRedirectUrl(token) {
  return publicUrl(`/go/wa/${enc(token)}`);
}

/** Telegram's webhook for the bot (lib/tgSetup.js registers it). */
function telegramWebhookUrl() {
  return publicUrl("/telegram/webhook");
}

/** The instance's own health check (lib/keepAwake.js pings it through the public URL). */
function healthUrl() {
  return publicUrl("/health");
}

/** The quick guide and FAQ (open to everyone; the bot's help reply links it). */
function guideUrl(lang) {
  return appUrl("guide", { lang: lang === "en" ? "en" : null });
}

/** A unit inside the broker web app. */
function unitAppUrl(code) {
  return appUrl(`units/${enc(code)}`);
}

/** Public unit page for clients: /<agency-slug>/<unit-code>?s=<share-token>. */
function unitPageUrl(agencySlug, code, shareToken) {
  if (!agencySlug || !code || !shareToken) throw new Error("unitPageUrl needs an agency slug, a code and a share token");
  return publicUrl(withQuery(`/${enc(agencySlug)}/${enc(code)}`, { s: shareToken }));
}

/** The client's viewing page (services/viewings.js): confirm, ask for another time, add to a calendar. */
function viewingUrl(token) {
  return appUrl(`v/${enc(token)}`);
}

/** C7: a client's comparison of up to 3 units. */
function compareUrl(agencySlug, token) {
  return publicUrl(`/${enc(agencySlug)}/compare/${enc(token)}`);
}

module.exports = {
  compareUrl,
  viewingUrl,
  waRedirectUrl,
  guideUrl,
  healthUrl,
  telegramWebhookUrl, withQuery, siteOrigin, appUrl, loginLinkUrl, searchUrl, unitAppUrl, unitPageUrl };
