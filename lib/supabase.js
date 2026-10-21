// lib/supabase.js
"use strict";
const { createClient } = require("@supabase/supabase-js");

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.warn("⚠️ [SUPABASE CONFIG]: Missing SUPABASE_URL or SUPABASE_KEY");
}

const supabase = createClient(supabaseUrl || "", supabaseKey || "", {
  auth: { persistSession: false }
});

const BUCKET = "listing-images";

/**
 * Uploads listing photography to designated storage path.
 */
async function uploadListingImage(agencyId, storagePath, buffer) {
  if (!buffer || !storagePath) return null;

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, buffer, {
      contentType: "image/jpeg",
      cacheControl: "31536000, immutable",
      upsert: false
    });

  if (error) {
    console.error(
      `❌ [SUPABASE IMAGE UPLOAD ERROR] (${storagePath}):`,
      error.message
    );
    return null;
  }

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(storagePath);
  return data?.publicUrl || null;
}

/**
 * Uploads on-demand flyer brochure buffer (overwriting stale versions cleanly).
 */
async function uploadFlyerImage(agencyId, storagePath, buffer) {
  if (!buffer || !storagePath) return null;

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, buffer, {
      contentType: "image/jpeg",
      cacheControl: "31536000, immutable",
      upsert: true
    });

  if (error) {
    console.error(
      `❌ [SUPABASE FLYER UPLOAD ERROR] (${storagePath}):`,
      error.message
    );
    throw error;
  }

  const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(storagePath);
  return pub.publicUrl;
}

/**
 * Permanently deletes media and flyer files from Supabase Storage.
 */
async function deleteStorageFiles(paths = []) {
  if (!paths || !paths.length) return true;
  const cleanPaths = paths.filter(Boolean);

  const { error } = await supabase.storage.from(BUCKET).remove(cleanPaths);
  if (error) {
    console.error("❌ [SUPABASE DELETE FILES ERROR]:", error.message);
    return false;
  }
  return true;
}

module.exports = {
  supabase,
  uploadListingImage,
  uploadFlyerImage,
  deleteStorageFiles
};
