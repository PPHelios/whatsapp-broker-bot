// scripts/audit-db-schema.js
"use strict";

require("dotenv").config();
const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");

const rootDir = path.join(__dirname, "..");

/**
 * Parses table and column names directly from SCHEMA_REFERENCE.sql
 * for offline CI and pre-commit schema validation.
 */
function parseSchemaReferenceFile() {
  const schemaFile = path.join(rootDir, "SCHEMA_REFERENCE.sql");
  if (!fs.existsSync(schemaFile)) return null;

  const content = fs.readFileSync(schemaFile, "utf8");
  const schema = {};

  const tableBlocks = content.split(
    /CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+public\.([a-zA-Z0-9_]+)\s*\(/gi
  );

  for (let i = 1; i < tableBlocks.length; i += 2) {
    const tableName = tableBlocks[i].toLowerCase();
    const tableBody = tableBlocks[i + 1].split(/\);/)[0];
    schema[tableName] = new Set();

    const lines = tableBody.split("\n");
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith("--") || line.startsWith("CONSTRAINT"))
        continue;

      const colMatch = line.match(/^([a-zA-Z0-9_]+)\s+/);
      if (colMatch) {
        schema[tableName].add(colMatch[1].toLowerCase());
      }
    }
  }

  return schema;
}

/**
 * Loads the active database schema catalog from live PostgreSQL or offline reference file.
 */
async function loadSchemaCatalog() {
  if (process.env.DATABASE_URL) {
    try {
      const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        connectionTimeoutMillis: 4000
      });
      console.log("🔍 Querying live PostgreSQL database schema catalog...");
      const { rows } = await pool.query(`
        SELECT table_name, column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
      `);
      await pool.end();

      const schema = {};
      for (const { table_name, column_name } of rows) {
        if (!schema[table_name]) schema[table_name] = new Set();
        schema[table_name].add(column_name.toLowerCase());
      }
      console.log(
        `✅ Loaded ${rows.length} columns across ${
          Object.keys(schema).length
        } tables from live DB.`
      );
      return schema;
    } catch (err) {
      console.warn(
        `⚠️ Live database unreachable (${err.message}). Falling back to SCHEMA_REFERENCE.sql...`
      );
    }
  } else {
    console.log(
      "ℹ️ DATABASE_URL not set. Auditing against SCHEMA_REFERENCE.sql..."
    );
  }

  const fileSchema = parseSchemaReferenceFile();
  if (!fileSchema) {
    console.error(
      "❌ Failed to load schema from live DB or SCHEMA_REFERENCE.sql."
    );
    process.exit(1);
  }
  console.log(
    `✅ Loaded schema catalog from SCHEMA_REFERENCE.sql (${
      Object.keys(fileSchema).length
    } tables).`
  );
  return fileSchema;
}

/**
 * Traverses files across routes, lib, and root while skipping irrelevant directories.
 */
function collectJavaScriptFiles(dir) {
  const files = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (
      entry.isDirectory() &&
      !["node_modules", ".git", "tests", "scripts", "coverage"].includes(
        entry.name
      )
    ) {
      files.push(...collectJavaScriptFiles(fullPath));
    } else if (
      entry.isFile() &&
      (entry.name.endsWith(".js") || entry.name.endsWith(".cjs"))
    ) {
      files.push(fullPath);
    }
  }

  return files;
}

async function auditCodebaseAgainstDatabase() {
  const schema = await loadSchemaCatalog();
  const scanDirs = ["routes", "lib", "."];
  const filesToScan = new Set();

  scanDirs.forEach((d) => {
    const targetDir = path.join(rootDir, d);
    if (fs.existsSync(targetDir)) {
      if (fs.statSync(targetDir).isDirectory()) {
        collectJavaScriptFiles(targetDir).forEach((f) => filesToScan.add(f));
      } else {
        filesToScan.add(targetDir);
      }
    }
  });

  let realIssues = 0;

  for (const file of filesToScan) {
    const relFile = path.relative(rootDir, file);
    const content = fs.readFileSync(file, "utf8");

    // 1. Audit INSERT INTO <table> (<col1>, <col2>, ...)
    const insertRegex =
      /INSERT\s+INTO\s+(?:public\.)?([a-zA-Z0-9_]+)\s*\(([^)]+)\)/gi;
    let insertMatch;
    while ((insertMatch = insertRegex.exec(content)) !== null) {
      const table = insertMatch[1].toLowerCase();
      const rawCols = insertMatch[2];

      if (schema[table]) {
        const columns = rawCols
          .split(",")
          .map((c) =>
            c
              .trim()
              .replace(/^["'`]|["'`]$/g, "")
              .toLowerCase()
          )
          .filter(Boolean);

        for (const col of columns) {
          if (!schema[table].has(col)) {
            console.error(
              `❌ [INSERT] Column mismatch in ${relFile}: "${table}.${col}" does NOT exist!`
            );
            realIssues++;
          }
        }
      }
    }

    // 2. Audit UPDATE <table> SET <col1> = ..., <col2> = ...
    const updateRegex =
      /UPDATE\s+(?:public\.)?([a-zA-Z0-9_]+)\s+SET\s+([\s\S]*?)(?:WHERE|RETURNING|;|$)/gi;
    let updateMatch;
    while ((updateMatch = updateRegex.exec(content)) !== null) {
      const table = updateMatch[1].toLowerCase();
      const setClause = updateMatch[2];

      if (schema[table]) {
        // Extract column names on the left of assignment
        const setColRegex = /(?:^|,)\s*([a-zA-Z0-9_]+)\s*=/g;
        let colAssignMatch;
        while ((colAssignMatch = setColRegex.exec(setClause)) !== null) {
          const col = colAssignMatch[1].trim().toLowerCase();
          if (!schema[table].has(col)) {
            console.error(
              `❌ [UPDATE] Column mismatch in ${relFile}: "${table}.${col}" does NOT exist in table "${table}"!`
            );
            realIssues++;
          }
        }
      }
    }

    // 3. Audit SELECT <cols> FROM <table> [alias]
    const sqlBlockRegex =
      /(?:`|"|')\s*(SELECT\s+[\s\S]*?FROM[\s\S]*?)(?:`|"|')/gi;
    let sqlMatch;
    while ((sqlMatch = sqlBlockRegex.exec(content)) !== null) {
      const sql = sqlMatch[1];
      const aliasMap = {};

      const fromJoinRegex =
        /(?:FROM|JOIN)\s+(?:public\.)?([a-zA-Z0-9_]+)(?:\s+(?:AS\s+)?([a-zA-Z0-9_]+))?/gi;
      let tableMatch;
      while ((tableMatch = fromJoinRegex.exec(sql)) !== null) {
        const table = tableMatch[1].toLowerCase();
        const alias = (tableMatch[2] || tableMatch[1]).toLowerCase();
        if (schema[table]) {
          aliasMap[alias] = table;
        }
      }

      const colRegex = /\b([a-zA-Z0-9_]+)\.([a-zA-Z0-9_]+)\b/g;
      let colMatch;
      while ((colMatch = colRegex.exec(sql)) !== null) {
        const alias = colMatch[1].toLowerCase();
        const column = colMatch[2].toLowerCase();

        if (
          [
            "new",
            "excluded",
            "now",
            "count",
            "jsonb_build_object",
            "coalesce"
          ].includes(alias)
        ) {
          continue;
        }

        if (aliasMap[alias]) {
          const targetTable = aliasMap[alias];
          if (!schema[targetTable].has(column)) {
            console.error(
              `❌ [SELECT] Column mismatch in ${relFile}: "${alias}.${column}" does NOT exist in "${targetTable}"!`
            );
            realIssues++;
          }
        }
      }
    }
  }

  if (realIssues === 0) {
    console.log(
      "🎉 100% SQL Catalog Integrity: All SELECT, INSERT, and UPDATE statements match the canonical schema!"
    );
    process.exit(0);
  } else {
    console.error(
      `\n🚨 Audit failed: Found ${realIssues} genuine SQL column mismatch(es).`
    );
    process.exit(1);
  }
}

auditCodebaseAgainstDatabase().catch((err) => {
  console.error("Audit runner crashed:", err);
  process.exit(1);
});
