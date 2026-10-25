// tests/harness/fake-push.js — Recording stand-in for the web push service (lib/channels/webpush.js sender)
"use strict";

const WebPush = require("../../lib/channels/webpush");

const sent = []; // { endpoint, payload (parsed), opts }
const statuses = new Map(); // endpoint -> HTTP status to fail with (404/410 remove the subscription)

function install() {
  WebPush.setSenderForTests(async (sub, payload, opts) => {
    const status = statuses.get(sub.endpoint);
    if (status) {
      const err = new Error(`push failed ${status}`);
      err.statusCode = status;
      throw err;
    }
    sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload), raw: payload, opts });
    return { statusCode: 201 };
  });
}

function reset() {
  sent.length = 0;
  statuses.clear();
}

/** Saves a subscription for a broker (as the settings page would). */
async function subscribe(pool, broker, endpoint = `https://push.example.test/${broker.id}`) {
  await pool.query(
    "INSERT INTO push_subscriptions (broker_id, agency_id, endpoint, p256dh, auth) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (endpoint) DO NOTHING",
    [broker.id, broker.agency_id, endpoint, "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", "tBHItJI5svbpez7KI4CCXg"]
  );
  return endpoint;
}

module.exports = { sent, statuses, install, reset, subscribe };
