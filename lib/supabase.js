// lib/supabase.js — Hardened Storage Client, Defensive Batch File Pruning & Media Pipelines
"use strict";

const { createClient } = require("@supabase/supabase-js");
const { logStdout } = require("./db");

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.warn("⚠️ Supabase client not initialized: Missing SUPABASE_URL or SUPABASE_KEY.");
  logStdout("warn", "Missing SUPABASE_URL or SUPABASE_KEY in environment");
}

const supabase = createClient(supabaseUrl || "", supabaseKey || "", {
  auth: { persistSession: false }
});

const BUCKET = "listing-images";

/**
 * Normalizes a storage path or full public URL into a clean bucket object key.
 */
function normalizeStoragePath(rawPath) {
  if (!rawPath || typeof rawPath !== "string") return "";
  const trimmed = rawPath.trim();
  const bucketMarker = `/${BUCKET}/`;
  if (trimmed.includes(bucketMarker)) {
    return trimmed.split(bucketMarker)[1];
  }
  return trimmed.replace(/^\/+/, "");
}

/**
 * Uploads listing photography to designated storage path.
 * Zero overwrite (`upsert: false`) to prevent accidental photo collisions.
 */
async function uploadListingImage(agencyId, storagePath, buffer) {
  if (!buffer || !storagePath) return null;
  const cleanPath = normalizeStoragePath(storagePath);

  try {
    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(cleanPath, buffer, {
        contentType: "image/jpeg",
        cacheControl: "31536000, immutable",
        upsert: false
      });

    if (error) {
      logStdout("error", "Supabase image upload failed", {
        path: cleanPath,
        agencyId,
        err: error.message
      });
      return null;
    }

    const { data } = supabase.storage.from(BUCKET).getPublicUrl(cleanPath);
    return data?.publicUrl || null;
  } catch (err) {
    logStdout("error", "Unexpected error during listing image upload", {
      path: cleanPath,
      agencyId,
      err: err.message
    });
    return null;
  }
}

/**
 * Uploads on-demand flyer brochure buffer (overwriting stale versions cleanly).
 */
async function uploadFlyerImage(agencyId, storagePath, buffer) {
  if (!buffer || !storagePath) return null;
  const cleanPath = normalizeStoragePath(storagePath);

  try {
    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(cleanPath, buffer, {
        contentType: "image/jpeg",
        cacheControl: "31536000, immutable",
        upsert: true
      });

    if (error) {
      logStdout("error", "Supabase flyer upload failed", {
        path: cleanPath,
        agencyId,
        err: error.message
      });
      throw error;
    }

    const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(cleanPath);
    return pub.publicUrl;
  } catch (err) {
    logStdout("error", "Unexpected error during flyer upload", {
      path: cleanPath,
      agencyId,
      err: err.message
    });
    throw err;
  }
}

/**
 * Permanently deletes media and flyer files from Supabase Storage in safe chunks.
 * Handles both relative paths and full CDN URLs gracefully.
 */
async function deleteStorageFiles(paths = []) {
  if (!paths || !Array.isArray(paths) || !paths.length) return true;

  const cleanPaths = paths
    .map(normalizeStoragePath)
    .filter((p) => Boolean(p && p.length > 2));

  if (!cleanPaths.length) return true;

  // Process in batches of 50 to prevent URI/payload truncation
  const CHUNK_SIZE = 50;
  let allSuccess = true;

  for (let i = 0; i < cleanPaths.length; i += CHUNK_SIZE) {
    const chunk = cleanPaths.slice(i, i + CHUNK_SIZE);
    try {
      const { data, error } = await supabase.storage.from(BUCKET).remove(chunk);

      if (error) {
        logStdout("error", "Supabase batch delete files failed", {
          err: error.message,
          chunkCount: chunk.length
        });
        allSuccess = false;
      }
    } catch (err) {
      logStdout("error", "Exception in Supabase deleteStorageFiles", {
        err: err.message,
        chunkCount: chunk.length
      });
      allSuccess = false;
    }
  }

  return allSuccess;
}

module.exports = {
  supabase,
  uploadListingImage,
  uploadFlyerImage,
  deleteStorageFiles
};
