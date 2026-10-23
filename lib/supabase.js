// lib/supabase.js — Hardened Storage Client, Defensive Batch File Pruning & Media Pipelines
"use strict";

const { createClient } = require("@supabase/supabase-js");

const supabaseUrl =
  process.env.SUPABASE_URL || "https://placeholder-domain.supabase.co";
const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  "placeholder-anon-key";

if (
  !process.env.SUPABASE_URL ||
  (!process.env.SUPABASE_SERVICE_ROLE_KEY && !process.env.SUPABASE_ANON_KEY)
) {
  if (process.env.NODE_ENV !== "test") {
    console.warn(
      "⚠️ Supabase client running in mock/fallback mode: Missing SUPABASE_URL or SUPABASE_KEY."
    );
  }
}

const supabase = createClient(supabaseUrl, supabaseKey, {
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
      console.error(
        JSON.stringify({
          t: new Date().toISOString(),
          level: "error",
          msg: "Supabase image upload failed",
          path: cleanPath,
          agencyId,
          err: error.message
        })
      );
      return null;
    }

    const { data } = supabase.storage.from(BUCKET).getPublicUrl(cleanPath);
    return data?.publicUrl || null;
  } catch (err) {
    console.error(
      JSON.stringify({
        t: new Date().toISOString(),
        level: "error",
        msg: "Unexpected error during listing image upload",
        path: cleanPath,
        agencyId,
        err: err.message
      })
    );
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
      console.error(
        JSON.stringify({
          t: new Date().toISOString(),
          level: "error",
          msg: "Supabase flyer upload failed",
          path: cleanPath,
          agencyId,
          err: error.message
        })
      );
      throw error;
    }

    const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(cleanPath);
    return pub.publicUrl;
  } catch (err) {
    console.error(
      JSON.stringify({
        t: new Date().toISOString(),
        level: "error",
        msg: "Unexpected error during flyer upload",
        path: cleanPath,
        agencyId,
        err: err.message
      })
    );
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
      const { error } = await supabase.storage.from(BUCKET).remove(chunk);

      if (error) {
        console.error(
          JSON.stringify({
            t: new Date().toISOString(),
            level: "error",
            msg: "Supabase batch delete files failed",
            err: error.message,
            chunkCount: chunk.length
          })
        );
        allSuccess = false;
      }
    } catch (err) {
      console.error(
        JSON.stringify({
          t: new Date().toISOString(),
          level: "error",
          msg: "Exception in Supabase deleteStorageFiles",
          err: err.message,
          chunkCount: chunk.length
        })
      );
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
