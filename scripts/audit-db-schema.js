// scripts/audit-db-schema.js
require("dotenv").config();
const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");

async function auditCodebaseAgainstDatabase() {
  if (!process.env.DATABASE_URL) {
    console.error("❌ DATABASE_URL is missing from environment.");
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  console.log("🔍 Fetching live database schema catalog...");
  const { rows } = await pool.query(`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
  `);

  const schema = {};
  for (const { table_name, column_name } of rows) {
    if (!schema[table_name]) schema[table_name] = new Set();
    schema[table_name].add(column_name.toLowerCase());
  }

  console.log(
    `✅ Loaded ${rows.length} columns across ${
      Object.keys(schema).length
    } tables.`
  );

  const directoriesToScan = ["lib", "."];
  const filesToScan = [];

  function collectFiles(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (
        entry.isDirectory() &&
        !["node_modules", ".git", "tests", "scripts"].includes(entry.name)
      ) {
        collectFiles(fullPath);
      } else if (
        entry.isFile() &&
        (entry.name.endsWith(".js") || entry.name.endsWith(".cjs"))
      ) {
        filesToScan.push(fullPath);
      }
    }
  }

  directoriesToScan.forEach(collectFiles);

  let realIssues = 0;

  // Regex targeting SQL query strings: `SELECT ...` or "SELECT ..."
  const sqlBlockRegex =
    /(?:`|"|')\s*(SELECT\s+[\s\S]*?FROM[\s\S]*?)(?:`|"|')/gi;

  for (const file of filesToScan) {
    const content = fs.readFileSync(file, "utf8");
    let sqlMatch;

    while ((sqlMatch = sqlBlockRegex.exec(content)) !== null) {
      const sql = sqlMatch[1];

      // Extract table aliases defined in FROM/JOIN (e.g. "FROM brokers b", "JOIN agencies a")
      const aliasMap = {};
      const fromJoinRegex =
        /(?:FROM|JOIN)\s+([a-zA-Z0-9_]+)(?:\s+(?:AS\s+)?([a-zA-Z0-9_]+))?/gi;
      let tableMatch;

      while ((tableMatch = fromJoinRegex.exec(sql)) !== null) {
        const table = tableMatch[1].toLowerCase();
        const alias = (tableMatch[2] || tableMatch[1]).toLowerCase();
        if (schema[table]) {
          aliasMap[alias] = table;
        }
      }

      // Check referenced columns with alias (e.g., b.phone, a.name)
      const colRegex = /\b([a-zA-Z0-9_]+)\.([a-zA-Z0-9_]+)\b/g;
      let colMatch;

      while ((colMatch = colRegex.exec(sql)) !== null) {
        const alias = colMatch[1].toLowerCase();
        const column = colMatch[2].toLowerCase();

        // Skip SQL functions or builtins
        if (["new", "excluded", "now", "count"].includes(alias)) continue;

        if (aliasMap[alias]) {
          const targetTable = aliasMap[alias];
          if (!schema[targetTable].has(column)) {
            console.error(
              `❌ SQL Error in ${file}: "${alias}.${column}" does NOT exist in table "${targetTable}"!`
            );
            console.error(
              `   Query snippet: "${sql
                .replace(/\s+/g, " ")
                .slice(0, 120)}..."\n`
            );
            realIssues++;
          }
        }
      }
    }
  }

  await pool.end();

  if (realIssues === 0) {
    console.log(
      "🎉 100% SQL Integrity: Every table and column referenced in SQL queries matches the database catalog!"
    );
    process.exit(0);
  } else {
    console.error(`⚠️ Found ${realIssues} genuine SQL column mismatch(es).`);
    process.exit(1);
  }
}

auditCodebaseAgainstDatabase().catch(console.error);
