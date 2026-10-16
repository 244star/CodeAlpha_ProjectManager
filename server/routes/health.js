const express = require("express");
const { pool, query } = require("../db/connection");

const router = express.Router();

router.get("/health", async (req, res) => {
  if (!pool) return res.json({ status: "ok", database: "not_configured" });
  try {
    await query("SELECT 1");
    res.json({ status: "ok", database: "connected" });
  } catch {
    res.status(503).json({ status: "degraded", database: "unavailable" });
  }
});

module.exports = router;
