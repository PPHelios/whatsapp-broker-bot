"use strict";

const sharp = require("sharp");
const AI = require("./ai");

// Permitted room classifications
const VALID_ROLES = [
  "facade",
  "reception",
  "master_bedroom",
  "bedroom",
  "kitchen",
  "bathroom",
  "terrace",
  "garden",
  "compound_amenity",
  "layout",
  "document",
  "unrelated",
  "other"
];
// F7: never on a flyer, a cover or a client page (kept in the unit's photos for the broker to delete).
const HIDDEN_ROLES = ["document", "unrelated"];

/**
 * Compresses an image buffer into a 768px native 1-tile thumbnail in memory.
 * Caps Gemini Vision cost at exactly 258 tokens per image.
 *
 * @param {Buffer} buffer - Original JPEG/PNG buffer
 * @returns {Promise<Buffer>}
 */
async function createVisionThumbnail(buffer) {
  return await sharp(buffer)
    .rotate()
    .resize(768, 768, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 80, progressive: false })
    .toBuffer();
}

/**
 * Downloads a photo buffer from a URL with timeout protection.
 *
 * @param {string} url
 * @returns {Promise<Buffer|null>}
 */
async function fetchImageBuffer(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (err) {
    console.warn(`[VISION] Failed to download image from ${url}:`, err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs Gemini Vision to classify, filter, and sequence property photos.
 *
 * @param {Array<{id: string, url: string, index: number, thumbnailBuffer: Buffer}>} images
 * @param {Object} ctx - Context containing db pool and broker data
 * @returns {Promise<Array<{id: string, role: string, score: number, isHero: boolean}>>}
 */
async function analyzePhotosWithGemini(images, ctx = {}) {
  const prompt = `You are an elite architectural photographer and creative director for luxury Egyptian real estate marketing brochures.
Analyze the following ${images.length} images for a property listing.

For each image (indexed 0 to ${images.length - 1}):
1. Classify the "role" into exactly one of:
   - "facade": Building exterior, villa front, landscaping with architecture.
   - "reception": Living room, salon, dining area, main hall.
   - "master_bedroom": Large bedroom, en-suite bed chamber.
   - "bedroom": Secondary bedrooms, kids room.
   - "kitchen": Kitchen, pantry.
   - "bathroom": Powder room, master bath, guest bath.
   - "terrace": Balcony, patio, rooftop view, open garden view.
   - "garden": Private garden, lawn, swimming pool.
   - "compound_amenity": Club house, shared pool, compound gates.
   - "layout": Floor plans, unit layout drawings, master plans (drawings, not photos).
   - "document": Paper contracts, installment tables, text screenshots, receipts.
   - "unrelated": Not part of the property: people, selfies, clothes, food, cars, chat or app screenshots, memes.
   - "other": Blurry shots, close-ups of AC units, electrical meters, plain walls.

2. Assign an "aesthetic_score" from 1 to 10 (lighting, wide angle, sharpness, luxury presentation).
3. Select exactly ONE image as "is_hero":
   - The HERO MUST be the single best wide-angle "facade" or spacious "reception".
   - Bathrooms, kitchens, bedrooms, layouts, documents, unrelated and blurry shots are NEVER allowed to be the hero.

4. Filter duplicates: If two photos show almost the same angle of the same room, downgrade the lower-quality one's score.

Return a STRICT JSON array matching this format without markdown code blocks:
[
  { "index": 0, "role": "facade", "aesthetic_score": 9, "is_hero": true },
  { "index": 1, "role": "reception", "aesthetic_score": 8, "is_hero": false }
]`;

  const contents = [
    {
      role: "user",
      parts: [
        { text: prompt },
        ...images.map((img) => ({
          inlineData: {
            mimeType: "image/jpeg",
            data: img.thumbnailBuffer.toString("base64")
          }
        }))
      ]
    }
  ];

  const result = await AI.generateWithCascade({
    contents,
    config: {
      temperature: 0.1,
      responseMimeType: "application/json"
    },
    operationType: "vision_curation",
    ctx
  });

  try {
    const parsed = JSON.parse(result.text.replace(/```json|```/g, "").trim());
    // One entry per image: an unknown or repeated index is dropped, a missed image comes back as "other".
    const seen = new Set();
    const out = [];
    for (const item of Array.isArray(parsed) ? parsed : []) {
      const id = images[item?.index]?.id;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        role: VALID_ROLES.includes(item.role) ? item.role : "other",
        score: typeof item.aesthetic_score === "number" ? item.aesthetic_score : 5,
        isHero: Boolean(item.is_hero) && !["layout", ...HIDDEN_ROLES].includes(item.role)
      });
    }
    for (const img of images) if (!seen.has(img.id)) out.push({ id: img.id, role: "other", score: 1, isHero: false });
    return out;
  } catch (err) {
    console.error(
      "[VISION] Failed to parse Gemini curation JSON:",
      result.text
    );
    // Fallback: assign first image as facade, others as reception/other
    return images.map((img, i) => ({
      id: img.id,
      role: i === 0 ? "facade" : "other",
      score: 5,
      isHero: i === 0
    }));
  }
}

/**
 * Lazy Curation Director:
 * Evaluates listing images. If roles are NULL, downloads photos, compresses to 768px,
 * runs Gemini Vision, and commits the curated sequence to PostgreSQL.
 *
 * @param {string} listingId - UUID of the listing
 * @param {Object} ctx - Context with pool, broker, etc.
 * @returns {Promise<Array<Object>>} Curated list of image records
 */
/** Whether the next flyer for this unit will run AI photo ordering (photos not ordered yet, AI ordering on, order not set by hand). */
async function needsCuration(pool, listingId) {
  const { rows } = await pool.query(
    `SELECT EXISTS (SELECT 1 FROM listing_images i WHERE i.listing_id = l.id AND i.role IS NULL) AS pending, l.details->>'photo_order' AS photo_order, a.crm_settings->>'ai_photo_order' AS ai
       FROM listings l JOIN agencies a ON a.id = l.agency_id WHERE l.id = $1`,
    [listingId]
  );
  const r = rows[0];
  return Boolean(r && r.pending && r.photo_order !== "manual" && r.ai !== "false");
}

async function ensureListingImagesCurated(listingId, ctx = {}) {
  const { pool } = ctx;

  // 1. Check existing images
  const { rows: existing } = await pool.query(
    "SELECT id, url, role, position FROM listing_images WHERE listing_id = $1 ORDER BY position ASC",
    [listingId]
  );

  if (existing.length === 0) return [];

  // Check if curation was already performed
  const needsCuration = existing.some((img) => img.role === null);
  if (!needsCuration) {
    return existing;
  }

  // P3: a broker who set the order by hand, or an agency that switched AI photo ordering off, keeps the order as is.
  const { rows: own } = await pool.query(
    "SELECT l.details->>'photo_order' AS photo_order, a.crm_settings->>'ai_photo_order' AS ai FROM listings l JOIN agencies a ON a.id = l.agency_id WHERE l.id = $1",
    [listingId]
  );
  if (own[0] && (own[0].photo_order === "manual" || own[0].ai === "false")) return existing;

  console.log(
    `[VISION] Lazy curation triggered for listing ${listingId} (${existing.length} photos)...`
  );

  // 2. Download and prepare 768px thumbnails in parallel (bounded concurrency)
  const prepared = [];
  for (let i = 0; i < existing.length; i++) {
    const img = existing[i];
    const rawBuffer = await fetchImageBuffer(img.url);
    if (rawBuffer) {
      try {
        const thumb = await createVisionThumbnail(rawBuffer);
        prepared.push({
          id: img.id,
          url: img.url,
          index: prepared.length,
          thumbnailBuffer: thumb
        });
      } catch (thumbErr) {
        console.warn(
          `[VISION] Thumbnail creation failed for image ${img.id}:`,
          thumbErr.message
        );
      }
    }
  }

  if (prepared.length === 0) {
    return existing;
  }

  // 3. Analyze with Gemini Vision
  const analysis = await analyzePhotosWithGemini(prepared, ctx);

  // 4. Creative Director Sorting Logic:
  //    - Hero photo comes first (position 0)
  //    - Up to 8 supporting photos respecting diversity quotas
  //    - Documents and blurry/trash photos pushed to the tail
  const curated = [];
  const tail = new Set(["layout", ...HIDDEN_ROLES]);
  const heroItem = analysis.find((a) => a.isHero) || analysis.find((a) => !tail.has(a.role)) || analysis[0];
  curated.push(heroItem);

  const roleCounts = { [heroItem.role]: 1 };
  const maxPerRole = {
    facade: 2,
    reception: 2,
    master_bedroom: 2,
    bedroom: 2,
    kitchen: 1,
    terrace: 1,
    garden: 1,
    compound_amenity: 1,
    bathroom: 1,
    document: 0, // exclude from top brochure spots
    other: 0
  };

  const remaining = analysis
    .filter(
      (a) => a.id !== heroItem.id && !tail.has(a.role) && a.role !== "other"
    )
    .sort((a, b) => b.score - a.score);

  for (const item of remaining) {
    const currentCount = roleCounts[item.role] || 0;
    const allowed = maxPerRole[item.role] ?? 1;

    if (currentCount < allowed && curated.length < 9) {
      curated.push(item);
      roleCounts[item.role] = currentCount + 1;
    }
  }

  // Then the other photos, then layouts, then documents and unrelated photos. Photos that couldn't be downloaded keep
  // their place among the other photos (as "other", so curation doesn't run again on every flyer).
  const assignedIds = new Set(curated.map((c) => c.id));
  const rank = (r) => (r === "layout" ? 1 : HIDDEN_ROLES.includes(r) ? 2 : 0);
  const rest = [
    ...analysis.filter((a) => !assignedIds.has(a.id)),
    ...existing.filter((img) => !analysis.some((a) => a.id === img.id)).map((img) => ({ id: img.id, role: "other", score: 0 }))
  ];
  for (const r of [0, 1, 2]) for (const item of rest) if (rank(item.role) === r) curated.push(item);

  // 5. Commit curated order and roles back to database inside transaction
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // F7: positions are unique per unit, so they move out of the way first (negative) and then take their new
    // places; updating them one by one in place collided (listing_images_listing_pos_uniq) and the order was lost.
    await client.query("UPDATE listing_images SET position = -1 - position WHERE listing_id = $1", [listingId]);

    for (let pos = 0; pos < curated.length; pos++) {
      const item = curated[pos];
      await client.query(
        "UPDATE listing_images SET role = $1, position = $2 WHERE id = $3",
        [item.role, pos, item.id]
      );
    }

    // Update image_order and hero_position in listings.details
    const imageOrder = curated.map((c) => c.id);
    await client.query(
      `UPDATE listings
       SET hero_position = 0,
           details = jsonb_set(details, '{image_order}', $1::jsonb),
           updated_at = NOW()
       WHERE id = $2`,
      [JSON.stringify(imageOrder), listingId]
    );

    await client.query("COMMIT");
  } catch (dbErr) {
    await client.query("ROLLBACK");
    console.error("[VISION] Failed to persist curated photo positions:", dbErr);
    return existing;
  } finally {
    client.release();
  }

  // 6. Return refreshed, curated list; .skipped = upload numbers (1-based) of the photos left out as unrelated.
  const { rows: refreshed } = await pool.query(
    "SELECT id, url, role, position FROM listing_images WHERE listing_id = $1 ORDER BY position ASC",
    [listingId]
  );
  refreshed.skipped = existing.map((img, i) => (curated.some((c) => c.id === img.id && c.role === "unrelated") ? i + 1 : null)).filter(Boolean);
  return refreshed;
}

module.exports = {
  VALID_ROLES,
  HIDDEN_ROLES,
  createVisionThumbnail,
  analyzePhotosWithGemini,
  needsCuration,
  ensureListingImagesCurated
};
