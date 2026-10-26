// domain/leases.js — Rental renewal rules (Release B, N4), pure: the lease end date, the yearly increase dates, which
// reminders are due on a Cairo day (60 and 30 days before the end, 30 days before each yearly increase while the lease
// runs) and the lease form.
"use strict";

const END_DAYS = [60, 30];
const INCREASE_DAYS = 30;
const DAY = 24 * 3600 * 1000;

const ymd = (d) => new Date(d).toISOString().slice(0, 10);
const utcDate = (s) => new Date(`${ymd(s)}T00:00:00Z`);

/** start + months (same day of month, clamped to the month's last day). */
function addMonths(start, months) {
  const d = utcDate(start);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + months;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(d.getUTCDate(), last)));
}

const endDate = (lease) => addMonths(lease.start_date, Number(lease.months));

/** Yearly increase dates strictly inside the lease: [{ n, date }]. */
function increaseDates(lease) {
  const end = endDate(lease);
  const out = [];
  for (let n = 1; n * 12 < Number(lease.months); n++) out.push({ n, date: addMonths(lease.start_date, n * 12) });
  return out.filter((x) => x.date < end);
}

/** Reminders due by `today` (YYYY-MM-DD) and not sent yet: [{ key, kind: 'end'|'increase', date, days }]. */
function dueReminders(lease, today) {
  if (!lease.remind) return [];
  const t = utcDate(today).getTime();
  const sent = new Set(lease.reminded || []);
  const out = [];
  const end = endDate(lease);
  if (end.getTime() >= t) {
    // Only the nearest end reminder: a lease entered 20 days before its end gets one, not two.
    const left = Math.round((end.getTime() - t) / DAY);
    const step = END_DAYS.filter((d) => left <= d).pop();
    if (step && !sent.has(`end${step}`)) out.push({ key: `end${step}`, kind: "end", date: end, days: left });
  }
  for (const inc of increaseDates(lease)) {
    const left = Math.round((inc.date.getTime() - t) / DAY);
    if (left >= 0 && left <= INCREASE_DAYS && !sent.has(`inc${inc.n}`)) out.push({ key: `inc${inc.n}`, kind: "increase", date: inc.date, days: left });
  }
  return out;
}

/** The form → { start_date, months, rent, increase_pct, tenant_name, remind } | { error }. */
function fromForm(f = {}) {
  const start = String(f.start_date || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || Number.isNaN(Date.parse(start))) return { error: "start_date" };
  const months = Number(String(f.months || "").trim());
  if (!Number.isInteger(months) || months < 1 || months > 120) return { error: "months" };
  const num = (v, max) => {
    const s = String(v ?? "").replace(/[,\s]/g, "");
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) && n >= 0 && n <= max ? n : NaN;
  };
  const rent = num(f.rent, 1e9);
  const inc = num(f.increase_pct, 100);
  if (Number.isNaN(rent)) return { error: "rent" };
  if (Number.isNaN(inc)) return { error: "increase_pct" };
  return { start_date: start, months, rent, increase_pct: inc, tenant_name: String(f.tenant_name || "").trim().slice(0, 120) || null, remind: f.remind === "1" || f.remind === "on" || f.remind === true };
}

module.exports = { END_DAYS, INCREASE_DAYS, ymd, addMonths, endDate, increaseDates, dueReminders, fromForm };
