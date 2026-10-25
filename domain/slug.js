// domain/slug.js — Agency slugs for public URLs (/<agency-slug>/<unit-code>) (pure)
// JS twin of the SQL in migration 005 (agency_slug_base); tests check they agree.
"use strict";

const MAX_BASE = 40;

// First path segments the app owns; an agency can never take them.
const RESERVED_SLUGS = [
  "app", "api", "auth", "login", "logout", "webhook", "health", "static", "assets", "public",
  "admin", "s", "u", "www", "aqarchat", "wehdathub", "about", "help", "terms", "privacy", "pricing", "blog", "docs",
  "robots", "favicon", "manifest", "sw", "share", "new"
];

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;

/** Latin slug from a name ("Pilot Agency" → "pilot-agency"); "" when the name has no Latin letters or digits. */
function slugify(name) {
  const s = String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s.slice(0, MAX_BASE).replace(/^-+|-+$/g, "");
}

/** The slug a new agency gets (before uniqueness): its slugified name, or agency-<id prefix>. */
function baseSlug(name, id) {
  const s = slugify(name);
  if (!s || RESERVED_SLUGS.includes(s)) return `agency-${String(id || "").replace(/-/g, "").slice(0, 8)}`;
  return s;
}

/** A slug an admin may choose: lower-case letters, digits and inner dashes, 1–48 chars, not reserved. */
function isValidSlug(slug) {
  return typeof slug === "string" && SLUG_RE.test(slug) && !RESERVED_SLUGS.includes(slug);
}

module.exports = { RESERVED_SLUGS, SLUG_RE, MAX_BASE, slugify, baseSlug, isValidSlug };
