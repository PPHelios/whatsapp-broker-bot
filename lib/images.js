// lib/images.js — Listing photo normalization (WhatsApp and web uploads share it). In memory only.
"use strict";

const sharp = require("sharp");

// Constrain Sharp concurrency and memory for Render containers
sharp.concurrency(1);
sharp.cache({ items: 20, memory: 64 });

const MAX_PHOTOS = 15;

/**
 * Normalizes a photo buffer before storage: auto-rotates via EXIF, bounds inside 1600x1600,
 * outputs progressive JPEG Q82.
 */
async function normalizeImageBuffer(rawBuffer) {
  return await sharp(rawBuffer)
    .rotate()
    .resize(1600, 1600, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 82, progressive: true })
    .toBuffer();
}

module.exports = { MAX_PHOTOS, normalizeImageBuffer };
