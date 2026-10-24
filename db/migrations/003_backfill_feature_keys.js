// 003: feature keys and free-text extras backfilled through the domain/features.js dictionary.
"use strict";

const Features = require("../../domain/features");

async function up(client) {
  const { rows } = await client.query(
    "SELECT id, features, details FROM listings WHERE feature_keys = '{}' AND features_other = '{}'"
  );
  for (const r of rows) {
    const details = r.details || {};
    const freeText = [...(r.features || []), ...(Array.isArray(details.features) ? details.features : [])];
    const { keys, other } = Features.classifyFeatures(freeText);
    const allKeys = Features.sortKeys([...keys, ...Features.keysFromDetails(details)]);
    if (allKeys.length || other.length) {
      await client.query("UPDATE listings SET feature_keys = $1, features_other = $2 WHERE id = $3", [
        allKeys,
        other,
        r.id
      ]);
    }
  }
}

module.exports = { up };
