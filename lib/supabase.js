// lib/supabase.js — Hardened Storage Client, Defensive Batch File Pruning & Media Pipelines
"use strict";

const fs = require("fs");
const { Readable, Transform } = require("stream");
const { pipeline } = require("stream/promises");
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

/** C7: the agency's logo (PNG, keeps transparency) at <agency>/brand/logo-<hash>.png; returns its public URL or null. */
async function uploadAgencyLogo(agencyId, storagePath, buffer) {
  if (!buffer || !storagePath) return null;
  const cleanPath = normalizeStoragePath(storagePath);
  try {
    const { error } = await supabase.storage.from(BUCKET).upload(cleanPath, buffer, { contentType: "image/png", cacheControl: "31536000, immutable", upsert: true });
    if (error) {
      console.error(JSON.stringify({ t: new Date().toISOString(), level: "error", msg: "Supabase logo upload failed", path: cleanPath, agencyId, err: error.message }));
      return null;
    }
    return supabase.storage.from(BUCKET).getPublicUrl(cleanPath).data?.publicUrl || null;
  } catch (err) {
    console.error(JSON.stringify({ t: new Date().toISOString(), level: "error", msg: "Unexpected error during logo upload", path: cleanPath, agencyId, err: err.message }));
    return null;
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

/**
 * Bytes of one of our listing images, for the web share page (the browser may only fetch same-origin).
 * Only URLs under our bucket's public prefix are fetched; anything else is null.
 */
async function downloadListingImage(url) {
  const prefix = `${supabaseUrl.replace(/\/+$/, "")}/storage/v1/object/public/${BUCKET}/`;
  if (typeof url !== "string" || !url.startsWith(prefix) || url.includes("..")) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    return buffer.length <= 15 * 1024 * 1024 ? { buffer, mimeType: res.headers.get("content-type") || "image/jpeg" } : null;
  } catch {
    return null;
  }
}

// --- WhatsApp chat exports (.zip with photos), uploaded by the browser straight to a private bucket ---------------
const CHAT_BUCKET = "chat-imports";
// Supabase Free refuses uploads over 50 MB whatever the bucket allows; on a paid plan raise CHAT_ZIP_MAX_MB (≤ 200).
const CHAT_ZIP_MAX_BYTES = Math.min(200, Math.max(1, Number(process.env.CHAT_ZIP_MAX_MB) || 50)) * 1024 * 1024;


/** A one-time signed URL the browser PUTs the zip to (valid 2 hours); null when Storage isn't set up. */
async function createChatUploadUrl(storagePath) {
  try {
    const { data, error } = await supabase.storage.from(CHAT_BUCKET).createSignedUploadUrl(storagePath);
    if (error || !data) throw error || new Error("no signed URL");
    return { url: data.signedUrl, path: data.path || storagePath };
  } catch (err) {
    console.error(JSON.stringify({ t: new Date().toISOString(), level: "error", msg: "Chat upload URL failed", path: storagePath, err: err.message }));
    return null;
  }
}

/**
 * Streams an uploaded chat export to a local temp file (never the whole zip in memory). Throws TOO_LARGE past the
 * cap and NOT_FOUND when nothing was uploaded there.
 */
async function downloadChatExportToFile(storagePath, file) {
  const { data, error } = await supabase.storage.from(CHAT_BUCKET).createSignedUrl(storagePath, 600);
  if (error || !data?.signedUrl) throw Object.assign(new Error("Chat export not found"), { code: "NOT_FOUND" });
  const res = await fetch(data.signedUrl, { signal: AbortSignal.timeout(10 * 60 * 1000) });
  if (!res.ok || !res.body) throw Object.assign(new Error(`Chat export download failed (${res.status})`), { code: res.status === 404 || res.status === 400 ? "NOT_FOUND" : "DOWNLOAD_FAILED" });
  if (Number(res.headers.get("content-length")) > CHAT_ZIP_MAX_BYTES) throw Object.assign(new Error("Chat export too large"), { code: "TOO_LARGE" });
  let bytes = 0;
  const cap = new Transform({
    transform(chunk, _enc, cb) {
      bytes += chunk.length;
      cb(bytes > CHAT_ZIP_MAX_BYTES ? Object.assign(new Error("Chat export too large"), { code: "TOO_LARGE" }) : null, chunk);
    }
  });
  await pipeline(Readable.fromWeb(res.body), cap, fs.createWriteStream(file));
  return { bytes };
}

async function deleteChatExport(storagePath) {
  try {
    await supabase.storage.from(CHAT_BUCKET).remove([storagePath]);
  } catch {
    // The bucket is private; a leftover zip is only storage. Nothing else to do.
  }
}

module.exports = {
  supabase,
  downloadListingImage,
  uploadListingImage,
  uploadFlyerImage,
  uploadAgencyLogo,
  deleteStorageFiles,
  CHAT_ZIP_MAX_BYTES,
  createChatUploadUrl,
  downloadChatExportToFile,
  deleteChatExport
};
