const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

/**
 * Uploads a compressed listing image buffer to Supabase Storage.
 * @param {string|number} agencyId
 * @param {string|number|null} listingId
 * @param {Buffer} buffer
 * @returns {Promise<string|null>} Public URL
 */
async function uploadListingImage(agencyId, listingId, buffer) {
  const randomSuffix = Math.random().toString(36).substring(2, 8);
  const path = `listings/${agencyId}/${listingId || 'unit'}_${Date.now()}_${randomSuffix}.jpg`;

  const { error } = await supabase.storage
    .from('listing-images')
    .upload(path, buffer, {
      contentType: 'image/jpeg',
      upsert: false
    });

  if (error) {
    console.error('❌ [SUPABASE IMAGE UPLOAD ERROR]:', error.message);
    return null;
  }

  const { data } = supabase.storage.from('listing-images').getPublicUrl(path);
  return data?.publicUrl || null;
}

/**
 * Uploads a generated Satori flyer buffer to Supabase Storage.
 * @param {string|number} agencyId
 * @param {string} listingCode
 * @param {Buffer} flyerBuffer
 * @returns {Promise<string|null>} Public URL
 */
async function uploadFlyerImage(agencyId, listingCode, flyerBuffer) {
  const filename = `flyers/${agencyId}/${listingCode}_${Date.now()}.jpg`;

  const { error } = await supabase.storage
    .from('flyers')
    .upload(filename, flyerBuffer, {
      contentType: 'image/jpeg',
      upsert: true
    });

  if (error) {
    console.error('❌ [SUPABASE FLYER UPLOAD ERROR]:', error.message);
    return null;
  }

  const { data } = supabase.storage.from('flyers').getPublicUrl(filename);
  return data?.publicUrl || null;
}

module.exports = {
  supabase,
  uploadListingImage,
  uploadFlyerImage
};