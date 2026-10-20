const { createClient } = require("@supabase/supabase-js");

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function uploadListingImage(agencyId, listingId, buffer) {
  const randomSuffix = Math.random().toString(36).substring(2, 8);
  const path = `listings/${agencyId}/${
    listingId || "unit"
  }_${Date.now()}_${randomSuffix}.jpg`;

  const { error } = await supabase.storage
    .from("listing-images")
    .upload(path, buffer, {
      contentType: "image/jpeg",
      cacheControl: "31536000, immutable",
      upsert: false
    });

  if (error) {
    console.error("❌ [SUPABASE IMAGE UPLOAD ERROR]:", error.message);
    return null;
  }

  const { data } = supabase.storage.from("listing-images").getPublicUrl(path);
  return data?.publicUrl || null;
}

async function uploadFlyerImage(agencyId, storagePath, buffer) {
  const { data, error } = await supabase.storage
    .from("listing-images")
    .upload(storagePath, buffer, {
      contentType: "image/jpeg",
      cacheControl: "31536000, immutable",
      upsert: true // Overwrite existing agent flyer cleanly on price/detail updates
    });

  if (error) throw error;
  const { data: pub } = supabase.storage
    .from("listing-images")
    .getPublicUrl(storagePath);
  return pub.publicUrl;
}

module.exports = { supabase, uploadListingImage, uploadFlyerImage };
