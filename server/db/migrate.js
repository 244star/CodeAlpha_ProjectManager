const fs = require("node:fs");
const path = require("node:path");
const { pool } = require("./connection");

// schema.sql is the single source of truth: it is run on every startup.
async function ensureDatabaseSchema() {
  if (!pool) return;
  const sql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  const statements = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
  for (const statement of statements) {
    await pool.query(statement);
  }
}

module.exports = { ensureDatabaseSchema };
