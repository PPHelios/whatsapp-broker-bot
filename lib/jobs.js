// lib/jobs.js — The scheduler's job list (lib/scheduler.js). Each Release 3 step adds its jobs here.
"use strict";

const Notifications = require("./notifications");

/**
 * Jobs for this instance: [{ name, everyMs, run({ pool, now, watermark, log }) }].
 * @param {Object} deps - { pool, config }
 */
function buildJobs(_deps = {}) {
  return [Notifications.deliverJob()];
}

module.exports = { buildJobs };
