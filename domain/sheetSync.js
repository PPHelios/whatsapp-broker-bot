// domain/sheetSync.js — Google Sheet live sync (Release B, C9), pure: a shared Google Sheets link → the sheet id and
// tab (gid) and the CSV export address the app reads; whether a project is due for its daily check; whether a
// preview has anything to apply.
"use strict";

const DAY = 24 * 3600 * 1000;
const CHECK_EVERY_MS = DAY;

/** "https://docs.google.com/spreadsheets/d/<id>/edit#gid=123" → { id, gid } | { error }. */
function parseLink(url) {
  let u;
  try {
    u = new URL(String(url || "").trim());
  } catch {
    return { error: "sheet_link" };
  }
  if (u.protocol !== "https:" || u.hostname !== "docs.google.com") return { error: "sheet_link" };
  const m = u.pathname.match(/^\/spreadsheets\/d\/([A-Za-z0-9_-]{20,100})(?:\/|$)/);
  if (!m) return { error: "sheet_link" };
  const gid = (u.hash.match(/gid=(\d{1,12})/) || u.search.match(/[?&]gid=(\d{1,12})/) || [])[1] || "0";
  return { id: m[1], gid };
}

/** The CSV export of one tab (built here, never taken from the user, so only Google is ever fetched). */
const exportUrl = ({ id, gid }) => `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;

/** A project with a link whose last check is a day old (or never ran). */
const isDue = (sync, now = new Date()) => Boolean(sync?.id) && (!sync.checked_at || now.getTime() - new Date(sync.checked_at).getTime() >= CHECK_EVERY_MS);

/** Anything to apply in a preview summary (new or changed rows; removed units only show). */
const hasChanges = (summary = {}) => Number(summary.new || 0) + Number(summary.changed || 0) + Number(summary.removed || 0) > 0;

module.exports = { CHECK_EVERY_MS, parseLink, exportUrl, isDue, hasChanges };
