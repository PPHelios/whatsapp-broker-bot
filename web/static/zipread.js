// web/static/zipread.js — Reads a .zip from a File/Blob in the browser, one entry at a time (the zip is never loaded
// whole into memory, so a 1 GB WhatsApp export is fine). Stored and deflated entries, zip64 sizes and offsets.
// Also loads in Node (tests): it only needs Blob, Response and DecompressionStream.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ZipRead = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const u64 = (dv, o) => Number(dv.getBigUint64(o, true));

  /** Finds the end-of-central-directory record in the last bytes of the file; returns { entries, size, offset }. */
  async function directoryOf(blob) {
    const tailLen = Math.min(blob.size, 22 + 65535);
    const base = blob.size - tailLen;
    const tail = new DataView(await blob.slice(base, blob.size).arrayBuffer());
    let eocd = -1;
    for (let i = tail.byteLength - 22; i >= 0; i--) {
      if (tail.getUint32(i, true) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw Object.assign(new Error("Not a zip file"), { code: "NOT_ZIP" });
    let entries = tail.getUint16(eocd + 10, true);
    let size = tail.getUint32(eocd + 12, true);
    let offset = tail.getUint32(eocd + 16, true);
    if (entries === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
      if (eocd < 20 || tail.getUint32(eocd - 20, true) !== 0x07064b50) throw Object.assign(new Error("Unreadable zip64 file"), { code: "NOT_ZIP" });
      const at = u64(tail, eocd - 20 + 8);
      const rec = new DataView(await blob.slice(at, at + 56).arrayBuffer());
      if (rec.getUint32(0, true) !== 0x06064b50) throw Object.assign(new Error("Unreadable zip64 file"), { code: "NOT_ZIP" });
      entries = u64(rec, 32);
      size = u64(rec, 40);
      offset = u64(rec, 48);
    }
    return { entries, size, offset };
  }

  /**
   * Opens a zip → { entries: [{ name, size, compressedSize, method, offset, encrypted }], blob(entry), text(entry) }.
   * @param {Blob} blob
   */
  async function open(blob) {
    const dir = await directoryOf(blob);
    const cd = new DataView(await blob.slice(dir.offset, dir.offset + dir.size).arrayBuffer());
    const utf8 = new TextDecoder("utf-8");
    const entries = [];
    let p = 0;
    while (p + 46 <= cd.byteLength && cd.getUint32(p, true) === 0x02014b50) {
      const flags = cd.getUint16(p + 8, true);
      const method = cd.getUint16(p + 10, true);
      let compressedSize = cd.getUint32(p + 20, true);
      let size = cd.getUint32(p + 24, true);
      const nameLen = cd.getUint16(p + 28, true);
      const extraLen = cd.getUint16(p + 30, true);
      const commentLen = cd.getUint16(p + 32, true);
      let offset = cd.getUint32(p + 42, true);
      const name = utf8.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen));
      // zip64 extra field: the 64-bit values of whatever was 0xFFFFFFFF above, in this order.
      let x = p + 46 + nameLen;
      const xEnd = x + extraLen;
      while (x + 4 <= xEnd) {
        const id = cd.getUint16(x, true);
        const len = cd.getUint16(x + 2, true);
        if (id === 0x0001) {
          let q = x + 4;
          if (size === 0xffffffff) { size = u64(cd, q); q += 8; }
          if (compressedSize === 0xffffffff) { compressedSize = u64(cd, q); q += 8; }
          if (offset === 0xffffffff) offset = u64(cd, q);
        }
        x += 4 + len;
      }
      if (!name.endsWith("/")) entries.push({ name, size, compressedSize, method, offset, encrypted: Boolean(flags & 1) });
      p += 46 + nameLen + extraLen + commentLen;
    }

    /** One entry's bytes as a Blob (decompressed when deflated). */
    async function blobOf(entry) {
      if (entry.encrypted) throw Object.assign(new Error("Password-protected zip"), { code: "ENCRYPTED" });
      const head = new DataView(await blob.slice(entry.offset, entry.offset + 30).arrayBuffer());
      if (head.getUint32(0, true) !== 0x04034b50) throw Object.assign(new Error("Damaged zip entry"), { code: "BAD_ENTRY" });
      const start = entry.offset + 30 + head.getUint16(26, true) + head.getUint16(28, true);
      const data = blob.slice(start, start + entry.compressedSize);
      if (entry.method === 0) return data;
      if (entry.method !== 8) throw Object.assign(new Error("Unsupported zip compression"), { code: "BAD_ENTRY" });
      return new Response(data.stream().pipeThrough(new DecompressionStream("deflate-raw"))).blob();
    }

    return { entries, blob: blobOf, text: async (entry) => (await blobOf(entry)).text() };
  }

  return { open };
});
