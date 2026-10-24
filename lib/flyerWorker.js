// lib/flyerWorker.js — Worker thread entry: renders flyers (satori + sharp) off the main event loop
"use strict";

const { parentPort } = require("worker_threads");
const sharp = require("sharp");
const { renderFlyerImage } = require("./flyer");

sharp.concurrency(1);
sharp.cache(false);

parentPort.on("message", async ({ id, payload }) => {
  try {
    const buf = await renderFlyerImage(payload);
    parentPort.postMessage({ id, ok: true, data: buf, rss: process.memoryUsage().rss });
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: err.message });
  }
});
