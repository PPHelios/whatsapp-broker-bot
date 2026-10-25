// lib/jobs.js — The scheduler's job list (lib/scheduler.js). Each Release 3 step adds its jobs here.
"use strict";

const Notifications = require("./notifications");
const MatchSweep = require("../services/matchSweep");
const FollowUpReminders = require("../services/followUpReminders");
const Privacy = require("../services/privacy");

/**
 * Jobs for this instance: [{ name, everyMs, run({ pool, now, watermark, log }) }].
 * @param {Object} deps - { pool, config }
 */
function buildJobs(_deps = {}) {
  return [Notifications.deliverJob(), MatchSweep.sweepJob(), FollowUpReminders.reminderJob(), Privacy.privacyJob()];
}

module.exports = { buildJobs };
