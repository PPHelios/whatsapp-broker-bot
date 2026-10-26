// domain/leadRules.js — Lead response rules (Release A, R3), pure: an agency's switch, the minutes a broker has to
// contact a new lead and the working hours those minutes count in (Cairo time), so a lead that arrives at 2 a.m. waits
// for the morning instead of jumping. dueAt() adds working minutes to a moment; awayNow() tells whether a broker is on
// leave; rulesFields() validates the managers' form.
"use strict";

const DEFAULTS = { enabled: false, wait_minutes: 30, start: 9, end: 21, days: [0, 1, 2, 3, 4, 5, 6], max_jumps: 2 };
const MIN_WAIT = 5;
const MAX_WAIT = 24 * 60;
const MAX_JUMPS = 5;
const HOUR = 3600 * 1000;
const MIN = 60 * 1000;

const int = (v) => {
  if (v === null || v === undefined || String(v).trim() === "") return null;
  const n = Number(String(v).replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d)).trim());
  return Number.isInteger(n) ? n : NaN;
};

/** The agency's rules with defaults (agencies.lead_rules). */
function rulesOf(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const hour = (v, d) => (Number.isInteger(v) && v >= 0 && v <= 24 ? v : d);
  const days = Array.isArray(r.days) ? [...new Set(r.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort() : DEFAULTS.days;
  return {
    enabled: r.enabled === true,
    wait_minutes: Number.isInteger(r.wait_minutes) && r.wait_minutes >= MIN_WAIT && r.wait_minutes <= MAX_WAIT ? r.wait_minutes : DEFAULTS.wait_minutes,
    start: hour(r.start, DEFAULTS.start),
    end: hour(r.end, DEFAULTS.end),
    days: days.length ? days : DEFAULTS.days,
    max_jumps: Number.isInteger(r.max_jumps) && r.max_jumps >= 1 && r.max_jumps <= MAX_JUMPS ? r.max_jumps : DEFAULTS.max_jumps
  };
}

/** The managers' form → { fields } | { error, field }. */
function rulesFields(input = {}) {
  const on = (v) => v === true || v === "on" || v === "1" || v === "true";
  const wait = int(input.wait_minutes);
  if (wait === null || Number.isNaN(wait) || wait < MIN_WAIT || wait > MAX_WAIT) return { error: "invalid", field: "wait_minutes" };
  const start = int(input.start);
  const end = int(input.end);
  if (start === null || Number.isNaN(start) || start < 0 || start > 23) return { error: "invalid", field: "hours" };
  if (end === null || Number.isNaN(end) || end < 1 || end > 24 || end === start) return { error: "invalid", field: "hours" };
  const days = [...new Set([].concat(input.days ?? []).map(int).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
  if (!days.length) return { error: "invalid", field: "days" };
  const jumps = int(input.max_jumps) ?? DEFAULTS.max_jumps;
  if (Number.isNaN(jumps) || jumps < 1 || jumps > MAX_JUMPS) return { error: "invalid", field: "max_jumps" };
  return { fields: { enabled: on(input.enabled), wait_minutes: wait, start, end, days, max_jumps: jumps } };
}

/** Cairo weekday (0 = Sunday) and hour of a moment. */
function cairo(at) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: "Africa/Cairo", hour12: false, weekday: "short", hour: "2-digit", minute: "2-digit" });
  const o = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]));
  return { day: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(o.weekday), hour: Number(o.hour) % 24, minute: Number(o.minute) };
}

/** Is this moment inside the working hours? An end before the start runs past midnight (the day is the start's). */
function inWorkHours(rules, at) {
  const { day, hour } = cairo(at);
  const { start, end, days } = rules;
  if (start < end) return days.includes(day) && hour >= start && hour < end;
  if (hour >= start) return days.includes(day);
  return hour < end && days.includes((day + 6) % 7);
}

/**
 * The moment a lead assigned at `from` must have been contacted: wait_minutes counted only in working hours.
 * Walks at most a fortnight (hour by hour outside the hours), so a broken setting can never loop.
 */
function dueAt(rules, from) {
  let t = new Date(from).getTime();
  let left = rules.wait_minutes * MIN;
  const stop = t + 14 * 24 * HOUR;
  while (left > 0 && t < stop) {
    const { minute } = cairo(new Date(t));
    const toHour = (60 - minute) * MIN - (t % MIN);
    if (inWorkHours(rules, new Date(t))) {
      const step = Math.min(left, toHour);
      t += step;
      left -= step;
    } else {
      t += toHour;
    }
  }
  return new Date(t);
}

/** On leave right now: no new leads, skipped by round robin, their reminders go to the managers. */
const awayNow = (broker, now = new Date()) => Boolean(broker?.away_until && new Date(broker.away_until).getTime() > now.getTime());

/** Minutes between two moments, whole. */
const minutesBetween = (from, to) => Math.max(0, Math.round((new Date(to).getTime() - new Date(from).getTime()) / MIN));

module.exports = { DEFAULTS, MIN_WAIT, MAX_WAIT, MAX_JUMPS, rulesOf, rulesFields, inWorkHours, dueAt, awayNow, minutesBetween, cairo };
