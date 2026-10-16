const express = require("express");
const requireDatabase = require("../middleware/require-database");
const requireAuth = require("../middleware/require-auth");
const { query } = require("../db/connection");
const { cleanString } = require("../lib/validate");

const router = express.Router();

function escapeLike(value) {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

// Find people by username or name prefix, for adding project members.
router.get("/", requireDatabase, requireAuth, async (req, res, next) => {
  const term = cleanString(req.query.q).replace(/^@/, "").slice(0, 50);
  if (!term) return res.json({ users: [] });
  try {
    const pattern = `${escapeLike(term)}%`;
    const rows = await query(
      "SELECT id, username, name FROM users WHERE username LIKE ? OR name LIKE ? ORDER BY username LIMIT 8",
      [pattern, pattern]
    );
    res.json({ users: rows });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
