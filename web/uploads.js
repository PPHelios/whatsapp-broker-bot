// web/uploads.js — Multipart uploads in memory only (never on disk: Render's disk is ephemeral)
"use strict";

const multer = require("multer");
const { csrfAfterParse } = require("./session");

const MB = 1024 * 1024;

/**
 * Express middleware for a set of file fields: [{ name, maxCount, maxMb, accept: RegExp }].
 * Files land in req.files[name] as buffers; a refused or oversized file answers 413/415.
 */
function uploads(fields, { maxMb = 10, fieldSizeKb = 256 } = {}) {
  const accept = Object.fromEntries(fields.map((f) => [f.name, f.accept]));
  const mw = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxMb * MB, files: fields.reduce((n, f) => n + f.maxCount, 0), fieldSize: fieldSizeKb * 1024, fields: 300 },
    fileFilter: (_req, file, cb) => {
      const re = accept[file.fieldname];
      if (re && !re.test(file.mimetype)) return cb(Object.assign(new Error(`Unsupported file type ${file.mimetype}`), { code: "UNSUPPORTED_TYPE" }));
      return cb(null, true);
    }
  }).fields(fields.map(({ name, maxCount }) => ({ name, maxCount })));
  return (req, res, next) =>
    mw(req, res, (err) => {
      if (!err) return csrfAfterParse(req) ? next() : res.status(403).send("Invalid or missing CSRF token");
      const status = err.code === "UNSUPPORTED_TYPE" ? 415 : err.code === "LIMIT_FILE_SIZE" || err.code === "LIMIT_FILE_COUNT" ? 413 : 400;
      return res.status(status).send(err.code === "UNSUPPORTED_TYPE" ? err.message : `Upload refused (${err.code || err.message})`);
    });
}

const PHOTO = { name: "photos", maxCount: 15, accept: /^image\// };
const VOICE = { name: "voice", maxCount: 1, accept: /^(audio|video)\/(ogg|webm|mp4|mpeg|aac|wav|x-m4a|m4a)/ };

module.exports = { MB, uploads, PHOTO, VOICE };
