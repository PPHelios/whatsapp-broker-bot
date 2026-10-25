// services/chatPhotos.js — Photos from a WhatsApp chat export with media (phase 2 step 5). The .zip WhatsApp makes
// holds the chat text and the photos; each photo goes to the listing post it belongs to (same sender, sent within
// minutes: domain/chatExport.js), up to 15 a post. Photos are read one at a time from the zip on disk (a big export
// never sits in memory), normalised like any listing photo, hashed for the duplicate-photo flag and stored; the
// group import review then shows them and applying a post attaches them to the new unit.
"use strict";

const path = require("path");
const unzipper = require("unzipper");
const Chat = require("../domain/chatExport");
const Supabase = require("../lib/supabase");
const { normalizeImageBuffer } = require("../lib/images");
const PhotoHash = require("./photoHash");

const MAX_TEXT_BYTES = 20 * 1024 * 1024;
const MAX_PHOTO_BYTES = 25 * 1024 * 1024;

/** True when a buffer starts like a zip file. */
const isZip = (b) => Buffer.isBuffer(b) && b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b;

/**
 * Opens a chat export zip ({ file } on disk or a small { buffer }) → { text, entries: Map file name → entry }.
 * Throws NO_CHAT when there is no chat text inside.
 */
async function openExport({ file = null, buffer = null }) {
  const dir = file ? await unzipper.Open.file(file) : await unzipper.Open.buffer(buffer);
  const files = dir.files.filter((f) => f.type === "File");
  const txt = files.filter((f) => /\.txt$/i.test(f.path) && f.uncompressedSize <= MAX_TEXT_BYTES).sort((a, b) => Number(/chat/i.test(path.basename(b.path))) - Number(/chat/i.test(path.basename(a.path))))[0];
  if (!txt) throw Object.assign(new Error("No chat text in the zip"), { code: "NO_CHAT" });
  const text = (await txt.buffer()).toString("utf8").slice(0, 5_000_000);
  const entries = new Map(files.map((f) => [path.basename(f.path), f]));
  return { text, entries };
}

/**
 * Stores the photos of each post: posts gain photos [{ url, hash, same_as (unit code), twin (earlier post index) }]
 * and missing (photos named in the chat but not in the zip, or unreadable). Mutates and returns posts.
 */
async function storePhotos(pool, broker, importId, posts, entries) {
  const all = [];
  for (const [n, post] of posts.entries()) {
    post.photos = [];
    post.missing = 0;
    for (const name of (post.files || []).slice(0, Chat.MAX_PHOTOS)) {
      const entry = entries.get(name);
      if (!entry || entry.uncompressedSize > MAX_PHOTO_BYTES) {
        post.missing++;
        continue;
      }
      try {
        const jpeg = await normalizeImageBuffer(await entry.buffer());
        const hash = await PhotoHash.hashImage(jpeg);
        const url = await Supabase.uploadListingImage(broker.agency_id, `listings/${broker.agency_id}/imports/${importId}/${n}_${post.photos.length}.jpg`, jpeg);
        if (!url) throw new Error("upload failed");
        const photo = { url, hash };
        const twin = hash ? all.find((o) => o.post < n && PhotoHash.distance(o.hash, hash) <= PhotoHash.MAX_DISTANCE) : null;
        if (twin) photo.twin = twin.post;
        post.photos.push(photo);
        if (hash) all.push({ post: n, hash });
      } catch {
        post.missing++;
      }
    }
    delete post.files;
  }
  const known = await PhotoHash.sameAs(pool, broker.agency_id, all.map((x) => x.hash));
  for (const post of posts) for (const p of post.photos) if (known.has(p.hash)) p.same_as = known.get(p.hash);
  return posts;
}

/**
 * Reads a chat export zip into group-import posts with their photos stored.
 * @returns {Promise<{ posts, skipped, duplicates, photos } | { error: no_chat|no_posts }>}
 */
async function postsFromExport(pool, broker, importId, source, { extraPosts = [] } = {}) {
  let opened;
  try {
    opened = await openExport(source);
  } catch (err) {
    if (err.code === "NO_CHAT" || /signature|zip|end of central directory/i.test(err.message)) return { error: "no_chat" };
    throw err;
  }
  const found = Chat.candidatePostsWithPhotos(opened.text);
  const posts = [...extraPosts, ...found.posts].slice(0, Chat.MAX_POSTS);
  if (!posts.length) return { error: "no_posts" };
  await storePhotos(pool, broker, importId, posts, opened.entries);
  return { posts, skipped: found.skipped, duplicates: found.duplicates, photos: posts.reduce((n, p) => n + (p.photos || []).length, 0) };
}

module.exports = { MAX_PHOTO_BYTES, isZip, openExport, storePhotos, postsFromExport };
