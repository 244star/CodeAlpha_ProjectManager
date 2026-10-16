const { pool } = require("../db/connection");

function requireDatabase(req, res, next) {
  if (!pool) return res.status(503).json({ error: "The database is not configured yet." });
  next();
}

module.exports = requireDatabase;
